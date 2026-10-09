# Audio capture and storage

How a participant recording travels from the browser to durable storage, and what the server checks on the way. Spec references: sections 31 to 36, 62 to 64, 84, 85, 106, 123, 135 and Appendix B of `docs/IMPLEMENTATION-SPEC.md`.

This document has two halves. "Browser capture" is written by the recorder work package (W2-RECORDER). Everything else describes the server side, implemented in `packages/storage` (`@dialect/storage`).

## Browser capture

Code: `apps/web/lib/client/recorder/` (the capture library), `apps/web/public/worklets/pcm-capture.worklet.js` (the audio thread script), `apps/web/components/participant/recorder/` (`useRecorder`, `RecordingTask`, `MicCheck`), and the development test page `/dev/recorder`.

The library does not call the participant API. It produces a recording object with capture metadata; the page uploads it.

### Capture path (spec 31.1)

```text
getUserMedia -> MediaStreamAudioSourceNode -> AudioWorkletNode "pcm-capture" -> (silent) destination
                                                    |
                                                    | Float32Array blocks through the message port
                                                    v
                              main thread: convert to integer PCM, collect chunks, write WAV
```

1. `requestMicrophone()` opens the microphone. It is called from a button press when the participant reaches a microphone step, never on page load.
2. `createRecorder(microphone, { prefer, maxDurationMs })` builds the audio graph for one recording and reports which implementation is in use.
3. The worklet processor copies channel 0 of each render block into a 2048-frame buffer and transfers each full buffer to the main thread. It changes no sample and writes nothing to its output. The node is connected to the destination only so that the browser keeps processing it; what flows there is silence, so the microphone is never audible.
4. The main thread converts each block to PCM bytes once and keeps it as its own chunk. At stop the file is a `Blob` of the 44-byte header plus the chunks: nothing is copied repeatedly while recording, and memory grows linearly (about 5.8 MB per minute at 48 kHz, 16 bit).
5. The RIFF and `data` sizes are written when the recording has ended, from the exact byte count. No placeholder size is ever produced.

Nothing else is done to the signal: no gain, normalization, noise reduction, resampling or trimming (spec 85). Elapsed time and duration come from the sample count divided by the sample rate, not from a timer. The maximum duration of the task is enforced on the sample count: the recorder stops by itself at exactly that many frames and the result says `stoppedBy: "max_duration"` (spec 9).

Only one recording can be active in a page. A second `start()` fails with `RECORDING_FAILED`.

### Constraints: what is requested and what is recorded (spec 31.1, 32)

Requested:

```text
channelCount: 1
echoCancellation: false
noiseSuppression: false
autoGainControl: false
sampleRate: { ideal: 48000 }     only where the browser lists sampleRate as a supported constraint
```

All of these are preferences, not hard requirements, so a device that cannot honor one still opens. The browser is free to ignore a preference. For that reason the recorder reads `track.getSettings()` after the stream has started and stores it unchanged as `actualTrackSettings`, next to `requestedConstraints`. Researchers should trust the actual settings, not the request.

`constraintMismatches` lists each requested setting that the track does not confirm:

| kind | Meaning |
|---|---|
| `not_honored` | the track reports another value (for example `echoCancellation: true`, or a 16000 Hz rate) |
| `not_reported` | the browser does not report this setting, so nothing is known about it |
| `context_rate_differs` | the AudioContext ran at another rate than the track (see below) |

A mismatch never blocks the participant. It is metadata for the page to store.

`track.getCapabilities()` is included where the browser provides it.

#### Device identifiers and the device label

The browser's track settings contain `deviceId` and `groupId`, which identify one device of the participant's computer across visits. The device label can contain a person's name ("Anna's AirPods"). Neither is research data, so neither leaves the browser:

- `describeMicrophone` (`lib/client/recorder/microphone.ts`) removes `deviceId` and `groupId` from `actualTrackSettings`, `requestedConstraints` and the capabilities. A chosen device is still requested from the browser by its id. Only the reported copy is cleaned.
- The label is replaced by a coarse **class of the input device**, which keeps what matters for acoustic analysis: `built_in`, `usb`, `bluetooth`, `headset` or `unknown`. The class is reported in the field `deviceLabel` (the field name is unchanged, its content is now the class).
- The rule is `classifyInputDevice` in `packages/domain/src/validators/sessions.ts`: the label is lower-cased and the first matching row wins.

  | Class | Keywords in the label |
  |---|---|
  | `bluetooth` | bluetooth, wireless, hands-free, airpods, buds |
  | `headset` | headset, headphone, earphone, earbud, kuuloke |
  | `usb` | usb, audio interface, or a USB vendor and product id such as `(046d:0825)`, which Chrome appends to the label of a USB device |
  | `built_in` | built-in, internal, integrated, microphone array, macbook, iphone, ipad, sisäinen |
  | `unknown` | anything else, and no label |

  The list is short on purpose: a label it does not recognize is `unknown`, never a guess. A wired headset on a combined jack usually reports the label of the built-in codec and is classed `built_in` or `unknown`.
- The server does the same again (request schemas and services), so a raw label or an identifier sent by an older page or another client is never stored.

### Sample rate honesty

The AudioContext is created with the sample rate that the track reports, so the browser has no reason to resample between the device and the recorder. If the track reports no rate, or the browser refuses that rate, the context runs at its default rate.

In every case the WAV header carries the real `AudioContext.sampleRate`, read from the running context. The recorder never resamples in JavaScript and never writes a rate it did not observe. The result contains both `actualTrackSettings.sampleRate` and `audioContextSampleRate`; when they differ, the browser resampled, and a `context_rate_differs` entry makes that visible.

A file is 48 kHz only when the device path really delivered 48 kHz. With Chromium's test microphone, for example, the track reports 44100 Hz and the file is a 44100 Hz file.

If the capture node receives more than one channel, channel 0 is kept and `inputChannelCount` records how many channels arrived. The file is always mono.

### Bit depth and sample conversion

Decision: 16-bit PCM by default, 24-bit PCM as an option (`bitDepth: 24`).

Reason for the default: spec 31.1 asks for at least 16 bit; 16-bit mono PCM WAV is read by every speech tool (Praat, ffmpeg, the ASR providers); and the noise of a laptop or headset microphone in a room is far above the 16-bit step size (about -96 dBFS), so 16 bit does not limit the recording. Choose 24 bit if a study uses a low-noise external microphone and wants the full precision of the browser's 32-bit float samples; the file is then 50 percent larger.

Conversion from the Web Audio float sample to an integer:

```text
value = round(sample * 2^(bits - 1)), limited to [-2^(bits - 1), 2^(bits - 1) - 1]
```

- One linear scale for the whole range (the rule ffmpeg uses). The signal is not bent around zero, which an asymmetric scale for positive and negative values would do.
- Only samples at or beyond full scale are limited. They are counted in `clippedSampleCount`, and `peak` holds the largest absolute value before conversion.
- Decision: no dither. Reason: the recording is the primary evidence, and dither would add generated noise that the microphone did not capture and would make the conversion non-reproducible. The microphone's own noise already exceeds one 16-bit step, so the rounding error is not correlated with the speech signal in practice.

### Fallback recorder and how it is marked (spec 31.2)

`MediaRecorderFallback` uses the browser's `MediaRecorder` with the first supported type of `audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/mp4`. It is used when:

- AudioWorklet does not exist in the browser, or it fails to start (the script cannot be loaded, the AudioContext cannot run);
- the page asks for it with `prefer: "compressed"` (Demo Mode).

A compressed recording is never presented as lossless:

| | PCM recorder | Fallback |
|---|---|---|
| `captureMethod` | `audio_worklet_pcm` | `media_recorder` |
| `captureQualityClass` | `lossless_pcm` | `compressed_fallback` |
| `mimeType` | `audio/wav` | the recorder's own type, for example `audio/webm;codecs=opus` |
| `bitDepth`, `audioContextSampleRate`, `peak` | set | `null` |
| `durationMs` | from the sample count | from the monotonic clock |

When PCM was preferred and the fallback is in use, `createRecorder` returns `fallback: { reason, detail }` and the components call `onFallback`, so the page can store the fact. The server classifies the upload from its bytes as well, so the two views can be compared.

### Stream lifecycle

Decision: the microphone stream is opened on the first press of a recording button in a step and kept open while that step is on screen. A re-recording in the same step uses the same stream, so the device stays the same and no new prompt appears. The stream is released when the step ends: on unmount of `RecordingTask` or `MicCheck`, on `discard()`, after a confirmed submit, after a recorder failure, and on `pagehide`. Each recording gets a new AudioContext, which is closed at stop.

Reason: between recording steps (instructions, questionnaires, debrief) the browser's microphone indicator must be off, and at session end and withdrawal nothing may stay open (spec 86, 138). Chromium remembers the permission for the site, so reopening the stream in the next step shows no prompt. The device in use is recorded with every recording, so a change of device between tasks is visible in the metadata.

Failures while recording: if the track ends (device unplugged) or the AudioContext stops running (suspended or interrupted by the browser), the recording is dropped and the control shows `RECORDING_FAILED` with a plain-language message. A partial recording is never offered as a candidate.

### Microphone check privacy rule (spec 6.3, 160.4)

`MicCheck` records about 5 seconds, plays it back with the native audio element and lets the participant try again or continue. The test audio exists only in browser memory. The component has no upload prop, and `onContinue` receives technical settings only: `audioEnvironment` (`requestedConstraints`, `actualTrackSettings`, `audioContextSampleRate`, `deviceLabel`, `captureMethod`), `browserInfo` (`userAgent`, `language`), `constraintMismatches` and `fallback`. The test recording and its blob URL are dropped on Try again, on Continue and on unmount. A test covers this.

If the test has almost no signal (peak below 0.002, about -54 dBFS) the participant sees a plain hint to check the microphone. This is a signal level check only. No speech, dialect or quality analysis is shown to the participant anywhere (spec 0B.4, 83).

### Retry and re-record rules (spec 10, 62)

- After Stop, the candidate stays in browser memory with a blob URL for playback (`media-src blob:` in the Content Security Policy).
- Record again: the previous candidate's blob URL is revoked and the data dropped before the new recording starts. `attemptCount` increases with every recording that starts.
- Submit: the page's `onSubmit(candidate, { attemptCount, onProgress })` runs. While its promise is pending the state is `uploading`.
- If the promise rejects, the state is `upload_failed` and the same candidate is kept. Retry calls `onSubmit` again with the same object. The participant is not asked to record again.
- Only when the promise resolves (the server confirmed durable storage) is the candidate released and its blob URL revoked.
- A minimum duration from the task disables Submit and shows a hint. It is not an error.
- Leaving the step, withdrawal and `pagehide` revoke all blob URLs and release the microphone.

Error categories (from `@dialect/domain`) with message keys that the page localizes: `MICROPHONE_PERMISSION_DENIED` (`microphone.permission_denied`), `RECORDING_FAILED` (`microphone.not_found`, `microphone.busy`, `microphone.unsupported`, `recording.device_disconnected`, `recording.interrupted`, `recording.start_failed`, `recording.empty`, `recording.already_active`) and `UPLOAD_FAILED` (`upload.failed`).

### Supported browser (spec 136)

The supported research browser is current Chromium or Chrome on the study laptop. The capture path is tested there with Playwright (`apps/web/e2e/recorder.spec.ts`), including a check that the worklet script loads under the Content Security Policy without a violation. Other browsers may work through the same code or through the fallback, but they are not acoustically equivalent and are not validated. `browserInfo.userAgent` is recorded so the environment of each session is known.

The page must be served over HTTPS (or from `localhost`): browsers do not expose the microphone otherwise.

### Known limits

- The operating system or the audio driver may apply its own processing (noise suppression, automatic gain, "voice clarity" effects, beamforming of a microphone array). The browser cannot disable it and cannot always see it. Turn such effects off in the system sound settings of the study laptop.
- Bluetooth headsets in call mode commonly deliver 16 kHz or 8 kHz speech-band audio. This is visible in `actualTrackSettings.sampleRate`. Prefer a wired or USB microphone.
- The reported settings are what the browser states. A reported `echoCancellation: false` is reliable for Chromium's own processing, but says nothing about processing below the browser.
- If the system changes the default input device during a session, the next step opens the new device. The label and settings stored with each recording show this.
- The browser may suspend audio processing in rare cases (device change, system sleep). The recording then fails visibly and must be repeated.
- The fallback recorder gives no peak level, so the silent-signal hint is not available there.
- Timestamps (`startedAt`) come from the browser clock.

### Validating capture on the study laptop (spec 136, Phase 7)

Run this once per laptop and microphone combination before data collection, on `/dev/recorder` in a development build (the page does not exist in production and sends no audio anywhere):

- [ ] Use the microphone and the room of the study. Close other programs that use the microphone.
- [ ] System sound settings: the intended input device is the default, input level is sensible, enhancements are off.
- [ ] Complete the mic check: the test can be heard clearly at playback.
- [ ] Record about 30 seconds of normal speech in the recording task.
- [ ] "Capture method" is `audio_worklet_pcm` and "Quality class" is `lossless_pcm`. No fallback line is shown.
- [ ] "Sample rate (file)", "AudioContext rate" and "Track rate" are the same number, ideally 48000.
- [ ] "Constraint mismatches" is `[]`. If not, note every entry: echo cancellation, noise suppression or automatic gain that stays on must be solved (another device or system setting) or documented for the study.
- [ ] "Clipped samples" is 0 and "Peak" is clearly above 0.05 and below 1 for normal speech.
- [ ] Download the file and open it in Praat or Audacity: the duration matches, the rate matches, speech is clear, there are no gaps or clicks, and the spectrogram shows energy above 8 kHz (a band limit at 4 or 8 kHz means a narrow-band device path).
- [ ] Turn on "Simulate upload failure once", submit, and check that Retry succeeds without recording again.
- [ ] Unplug the microphone while recording: the page shows a clear error and Try again works after reconnecting.
- [ ] After the task, the browser's microphone indicator is off.
- [ ] Record the laptop model, operating system, browser version, microphone and the values above in the study log.

What the server expects from the browser, so the two halves fit:

- One file per accepted attempt, sent as bytes. The server accepts WAV (PCM or IEEE float), WebM with Opus, Ogg with Opus, and MP4 with AAC.
- A WAV file must have a correct header: the `data` chunk size must equal the number of audio bytes that follow. A header with a placeholder size is rejected as truncated.
- The content type and duration sent by the browser are recorded for comparison only. The server determines both from the bytes.
- `capture_method`, the requested constraints and the actual track settings are metadata the browser reports. The server stores them and does not verify them.

## Server side

### Rules that never change

1. A stored source recording never mutates (spec 106, 110). Every driver refuses to write to a key that already exists and reports `AppError("CONFLICT")`.
2. Audio is never publicly addressable (spec 35, 36, 135). The local driver refuses a root inside any directory named `public`. The S3 driver never sends an ACL. Downloads go through authenticated server routes, or through a signed URL that lives at most 900 seconds.
3. Object keys contain UUIDs and the study slug only, never a participant name or participant code (spec 36, 123).
4. Audio bytes are never stored in PostgreSQL (spec 34). The database holds the key, size, SHA-256 and technical metadata, and stays authoritative for relationships (Appendix B).
5. The master audio is never normalized, denoised or otherwise altered (spec 85). A derived file is always a separate media asset that names its source.

### Upload sequence (spec 62)

The route handler and the service function in `packages/research` own this sequence. The storage package supplies steps 2 to 4.

1. Receive the upload and enforce the request size limit while reading.
2. `validateUploadedAudio(...)`: check size, container, codec, audio track and duration from the bytes.
3. Build the key with `sourceAudioKey(...)` using a new asset UUID and the extension returned by validation.
4. `storage.put(...)`: write the bytes and receive `sizeBytes` and `sha256`.
5. Commit the media record and link it to the utterance in one database transaction.
6. Only then answer with success, so the browser may release its copy.

If step 5 fails after step 4 succeeded, delete the object (`storage.delete` is idempotent) or leave it for a cleanup job. Never link a media row whose object was not written. A retry after a failure uses a new asset UUID, so it never collides with a half-finished earlier attempt.

### Validation (spec 63)

`validateUploadedAudio({ data, declaredMimeType?, maxBytes, maxDurationSeconds, minDurationMs? })`

| Check | Failure |
|---|---|
| File is not empty | `INVALID_AUDIO`, reason `empty` |
| Size is at most `maxBytes` | `PAYLOAD_TOO_LARGE`, reason `too_large` |
| Bytes parse as media | `INVALID_AUDIO`, reason `unparsable` (or a WAV reason: `truncated`, `bad_fmt_chunk`, `unsupported_encoding`, `missing_fmt_chunk`, `missing_data_chunk`) |
| An audio track exists | `INVALID_AUDIO`, reason `no_audio_track` |
| No video track | `INVALID_AUDIO`, reason `has_video_track` |
| Container is WAV, WebM, Ogg or MP4 | `INVALID_AUDIO`, reason `unsupported_container` |
| Codec fits the container (Opus in WebM and Ogg, AAC in MP4) | `INVALID_AUDIO`, reason `unsupported_codec` |
| 1 or 2 channels | `INVALID_AUDIO`, reason `unsupported_channel_count` |
| Sample rate from 8000 to 96000 Hz | `INVALID_AUDIO`, reason `unsupported_sample_rate` |
| WAV sample size is 16, 24 or 32 bits (PCM), or 32 bit float | `INVALID_AUDIO`, reason `unsupported_bit_depth` |
| Duration is above zero and at least `minDurationMs` | `INVALID_AUDIO`, reason `zero_duration` or `too_short` |
| Duration is at most `maxDurationSeconds` | `INVALID_AUDIO`, reason `too_long` |

The reason code is in `error.details.reason`. The error message is safe to show to a participant: it contains no file path and no tool output. The tool output is kept in `error.cause` for the server log.

How the format is determined:

- A file that starts with `RIFF....WAVE` is parsed by `parseWavHeader`, a pure parser in this package. Lossless uploads therefore do not depend on ffprobe being installed.
- Any other file is inspected with `ffprobe`. ffprobe reports the same name for WebM and Matroska, so the EBML DocType in the file header decides between them.
- A WebM written by MediaRecorder usually has no duration in its header. In that case the duration is computed from the packet timestamps of the audio stream.
- The declared MIME type is compared with the result and returned as `declaredMimeTypeMatches`. A mismatch is not a reason to reject.

Why the channel, rate and sample size limits exist: the header of a file decides how much data the tools produce from it. A WAV header that declares a 1 Hz sample rate made 200 bytes count as 100 seconds of audio, and a file that declares 255 channels would decode to gigabytes. Speech recordings are mono or stereo at 8 to 96 kHz, and the specification asks for at least 16 bits, so 8 bit audio is refused. The limits are checked before anything decodes the file (`MAX_AUDIO_CHANNELS`, `MIN_SAMPLE_RATE_HZ`, `MAX_SAMPLE_RATE_HZ`, `ACCEPTED_PCM_BIT_DEPTHS` in `validate.ts`).

Result: `mimeType`, `extension`, `container`, `codec`, `sampleRateHz`, `channels`, `bitDepth` (null for lossy codecs), `durationMs`, `sizeBytes`, `captureQualityClass`, `declaredMimeTypeMatches` and `probe` (for `media_assets.metadata_json.probe`).

What `probe` holds: for WAV the numbers of the header. For a compressed file an allow-list of technical fields of the ffprobe output (`technicalProbeFields`): of the format `format_name`, `nb_streams`, `duration`, `size`, `bit_rate`, `probe_score`, and of each stream `index`, `codec_type`, `codec_name`, `profile`, `sample_fmt`, `sample_rate`, `channels`, `channel_layout`, `bits_per_sample`, `bits_per_raw_sample`, `bit_rate`, `duration`, `start_time`, `time_base`. The tags of the file (title, artist, comment, encoder and so on) are chosen by whoever made the file and are never stored, and neither is the path of the temporary file that ffprobe read.

`captureQualityClass` is `lossless_pcm` for WAV and `compressed_fallback` for everything else (spec 31.2), so compressed recordings can be left out of strict acoustic analyses.

Note on Opus: Opus always decodes at 48 kHz, and ffprobe reports 48000 Hz for every Opus stream whatever the microphone rate was. The `sample_rate_hz` of a compressed fallback asset describes the decoded stream, not the capture device. The device rate belongs in the actual track settings reported by the browser.

#### Running ffmpeg and ffprobe on untrusted files

- The tools are started with an argument array and no shell, with a timeout (30 seconds for probing, 120 seconds for derivation).
- `-protocol_whitelist file` and `-format_whitelist` limit them to local files and to the containers named in `PROBE_FORMAT_ALLOWLIST`. A playlist or script format in an upload therefore cannot make the tools open other files or network addresses. A test covers this.
- A Buffer is written to a private temporary directory under the OS temp directory, without a file extension, and the directory is removed afterwards.
- `FFMPEG_PATH` and `FFPROBE_PATH` override the lookup in `PATH`. `ffmpegAvailable()` reports the installed versions for the Settings page and the readiness check.
- If the tools are missing, WAV uploads still work. Compressed uploads and derivation fail with `AppError("CONFIGURATION_MISSING")`.

### Hashing (spec 33)

Every driver computes the SHA-256 and the size locally while the bytes stream to their destination, and returns both from `put`. The hash is hex encoded and equals the output of `sha256sum` on the stored file (a test checks this). `sha256OfBuffer`, `sha256OfStream` and `createHashingStream` are exported for integrity checks and export manifests.

### Canonical WAV derivation (spec 64, 106)

`deriveCanonicalWav({ data, sampleRateHz?, channels?, bitDepth?, output? })` decodes a compressed upload to PCM WAV with ffmpeg.

- By default nothing is resampled and no channels are mixed: the output keeps the sample rate and channel count of the decoded source. `sampleRateHz` and `channels` exist for an explicitly requested conversion, and then appear in the recorded command.
- Output is 16 bit PCM by default, 24 bit on request.
- Tags and encoder names are left out of the output (`-map_metadata -1`, bitexact flags), so the same input and the same ffmpeg version give the same bytes and the same hash.
- The function returns the WAV (bytes, or a temporary file with a `cleanup` function), its parsed header, and the provenance `{ tool: "ffmpeg", toolVersion, command, createdAt }`. `command` is the exact argument list with the temporary paths replaced by `<input>` and `<output>`.

The derivation job (`deriveWavForAsset` in `packages/research/src/processing/derive.ts`) holds neither file in memory: the source is streamed from storage to a temporary file and hashed on the way, ffmpeg writes the WAV to a second temporary file (`output: "file"`), and that file is streamed into storage. A long compressed recording decodes to a WAV many times its size. Both temporary files are removed afterwards, also after a failure.

The caller stores the result as a new media asset of kind `source_audio_derived` with `derived_from_media_asset_id` pointing at the raw upload, and writes the provenance to `metadata_json.derivation`. The raw upload stays where it is. Both files sit next to each other under the utterance's `source/` directory with different asset UUIDs (Appendix B).

### Quality indicators (spec 84, 85)

`computeWavQuality(buffer)` returns `{ peakAmplitude, clippedSampleRatio, silenceRatio, rmsDb, warnings }` for 16, 24 and 32 bit PCM and 32 bit float WAV. The shape matches `UtteranceQuality` in `packages/db/src/json-types.ts`.

| Value | Meaning |
|---|---|
| `peakAmplitude` | largest absolute sample value, 0 to 1 |
| `clippedSampleRatio` | share of samples at or beyond full scale |
| `silenceRatio` | share of 20 ms windows with a level below -50 dBFS |
| `rmsDb` | level of the whole file in dBFS, limited to -120 for digital silence |

Warnings: `possible_clipping` (more than 0.1 percent of samples clipped), `low_signal` (level below -40 dBFS), `mostly_silent` (more than 80 percent silent windows), `no_audio_data`, `unsupported_sample_format`.

These thresholds are simple and chosen for this project (decision: fixed constants exported from `packages/storage/src/audio/quality.ts`, so they are visible and testable; reason: spec 85 asks only for lightweight checks). They only feed flags that a researcher reviews. Nothing is excluded automatically, and the function never changes the audio.

### Storage layout (spec 36, Appendix B)

| Content | Key | Builder |
|---|---|---|
| Source recording, raw or derived | `studies/{study}/sessions/{session}/utterances/{utterance}/source/{asset}.{ext}` | `sourceAudioKey` |
| Synthesized speech | `studies/{study}/generated/syntheses/{synthesis}/{asset}.{ext}` | `ttsAudioKey` |
| Export archive | `studies/{study}/exports/{exportJob}/{fileName}` | `exportArchiveKey` |

`{study}` is the study slug (lowercase letters, digits, hyphens). Every id must be a UUID: the builders throw `AppError("VALIDATION_ERROR")` for anything else, which keeps participant codes and names out of keys. With the local driver the key is the path below the storage root, so the tree matches Appendix B.

Decision: the generated audio key follows Appendix B (`generated/syntheses/...`), not the shorter example in spec 36 (`translations/{translation}/tts/...`). Reason: Appendix B is the more detailed of the two and one synthesis can exist without a translation (the baseline condition).

Every driver validates the key on every call and rejects absolute paths, `.` and `..` segments, empty segments, backslashes, control characters (including the null byte), and the reserved prefix `.tmp`.

### Drivers

All drivers implement `StorageAdapter` (`packages/storage/src/StorageAdapter.ts`): `put`, `get` (with an inclusive byte range for HTTP Range requests), `stat`, `delete` (idempotent), `exists`, `healthCheck`, and for S3 `getSignedDownloadUrl`.

Errors: a missing object is `AppError("MEDIA_NOT_FOUND")` on `get` and `null` on `stat`. An existing key on `put` is `AppError("CONFLICT")`. Everything else is `AppError("STORAGE_ERROR")` with the original error as `cause`. A byte range that cannot be served is a `STORAGE_ERROR` with `details.reason = "range_not_satisfiable"`: a streaming route should call `stat` first and answer 416 itself.

**Local filesystem (`local`).** For development and a single machine.

- The body is streamed into `<root>/.tmp/<uuid>.part`, hashed on the way, and flushed with fsync.
- The finished file is then published under its final name with a hard link, and the temporary name is removed. A hard link fails when the destination exists, which rename does not, so "create only if absent" is atomic even with two writers. On a filesystem without hard links the driver falls back to an existence check followed by rename.
- A reader sees either no file or the complete file. A failed upload leaves nothing behind.
- `healthCheck` writes and removes a probe file in `<root>/.tmp`.

**S3-compatible (`s3`).** AWS SDK v3, with optional custom endpoint and path-style addressing.

- Buffers are sent with one `PutObject`. Streams go through the SDK's multipart upload while the driver hashes the bytes locally.
- Overwrite protection has two layers: an existence check before the write, and `If-None-Match: *` on the write so the store itself refuses. For a store that rejects this header, construct the driver with `conditionalWrites: false`; the existence check then remains (without protection against two writers at the same instant, which cannot happen with keys built from new UUIDs).
- No ACL is ever sent. The bucket must block public access.
- `getSignedDownloadUrl(key, ttlSeconds)` shortens any longer request to `maxSignedUrlTtlSeconds` (default 900).
- `healthCheck` uses `HeadBucket`.

**In memory (`memory`).** For unit tests in other packages: `new InMemoryStorage()` or `createInMemoryStorage()`. Same behavior as the other drivers.

### Configuration

| Variable | Meaning |
|---|---|
| `STORAGE_DRIVER` | `local` (default) or `s3` |
| `LOCAL_STORAGE_ROOT` | directory for the local driver, for example `./data/media` |
| `S3_ENDPOINT` | optional custom endpoint |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | required for `s3` |
| `S3_FORCE_PATH_STYLE` | `true` or `false` (default `false`) |

`storageConfigFromEnv(env)` reads these and throws `AppError("CONFIGURATION_MISSING")` naming what is missing. `createStorage(config)` returns the driver.

Decision: a relative `LOCAL_STORAGE_ROOT` is resolved against the repository root, which is the nearest parent directory containing `pnpm-workspace.yaml`, searched first from the current working directory and then from the storage package's own location. Reason: the web app runs from `apps/web` and the worker from `apps/worker`, and both must read and write the same directory. `storageConfigFromEnv(env, { baseDir })` sets the base directory explicitly. In a deployment that does not contain `pnpm-workspace.yaml` (a container image, for example), use an absolute path: a relative one is refused instead of being resolved against an arbitrary directory.

`data/` is in `.gitignore`. Participant audio must never be committed.

### Tests

`pnpm --filter @dialect/storage test`. Tests that need ffmpeg generate their sample files at run time and are skipped with a message when ffmpeg is absent. An integration test against a real S3-compatible store runs only when `TEST_S3_ENDPOINT` is set (with `TEST_S3_BUCKET`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY` and optionally `TEST_S3_REGION`).

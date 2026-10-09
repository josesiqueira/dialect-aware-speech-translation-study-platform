import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, PageHeading, SectionHeading, tableClasses } from "@/components/ui";
import { REFERENCES } from "../references";
import { Cite, referenceAnchor } from "./Cite";

/*
 * The research plan behind the platform, for researchers and stakeholders.
 * It restates docs/IMPLEMENTATION-SPEC.md (sections 1, 2, 7, 16, 20 to 23, 74,
 * 110, 150 to 167, Appendix D) and docs/RESEARCH-DESIGN.md, grounded in the
 * works of references.ts. It describes a study that has not been carried out:
 * nothing here is a finding.
 */

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <SectionHeading id={id} title={title} description={description} size="lg" className="mb-0" />
      {children}
    </section>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return <div className="space-y-3 text-sm leading-6 text-slate-700">{children}</div>;
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className={tableClasses.wrapper}>
      <table className={tableClasses.table}>
        <thead className={tableClasses.thead}>
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col" className={tableClasses.th}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={tableClasses.tbody}>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 align-top text-sm leading-6 text-slate-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MOTIVATION: Array<{ title: string; body: ReactNode }> = [
  {
    title: "Spoken Finnish is not the written standard",
    body: (
      <>
        Standard written Finnish has very seldom been anyone&apos;s first variety. For most of the 20th century public
        speech in Finland followed a &quot;speech should copy writing&quot; ideology, while regional and urban spoken
        forms kept spreading and changing <Cite refs={["Nuolijärvi & Vaattovaara 2011"]} />. Finnish has eight main
        dialect groups <Cite refs={["Kotus"]} />, and the difference between <i>me menemme</i> (standard),{" "}
        <i>me mennään</i> (common spoken) and <i>myö männään</i> (eastern) is part of everyday talk. Speakers tie
        identity, and sometimes stigma, to regional speech <Cite refs={["Palander 2007"]} />. Regional forms are not
        only history: a 2025 survey of 1,037 upper secondary students in 17 locations still found clear regional
        patterns in the forms they report using <Cite refs={["Kuparinen & Vaattovaara 2025"]} />, and most
        non-standard Finnish written online is colloquial rather than regional <Cite refs={["Kuparinen 2024"]} />.
      </>
    ),
  },
  {
    title: "How someone speaks carries meaning",
    body: (
      <>
        Linguistic variants are not noise around a message. They signal stance, persona and belonging, and what they
        signal depends on context <Cite refs={["Eckert 2008", "Agha 2003", "Podesva 2007"]} />. Changing a single
        feature can change how listeners judge a speaker <Cite refs={["Campbell-Kibler 2007"]} />. A translation can
        keep the content and still misrepresent the person who spoke.
      </>
    ),
  },
  {
    title: "Translation has a long-known pull toward the standard",
    body: (
      <>
        Translators tend to replace marked features of the source with the habitual options of the target language,
        a tendency described as the law of growing standardization <Cite refs={["Toury 1995"]} />. It has been
        observed for Finnish regional dialogue translated into English and Swedish <Cite refs={["Leppihalme 2000"]} />{" "}
        and in other language pairs <Cite refs={["Ramos Pinto 2009", "Määttä 2004", "Rosa 2012"]} />. Translators
        also have alternatives to neutralization, from compensation to moving the speech into a target-language
        dialect <Cite refs={["Berezowski 1997"]} />. Choosing among them is a known, unsolved problem.
      </>
    ),
  },
  {
    title: "Machine translation measurably reduces linguistic richness",
    body: (
      <>
        Neural machine translation is lexically and morphologically less rich than human translation, and rare words
        used by human translators can disappear from its output altogether{" "}
        <Cite refs={["Vanmassenhove et al. 2019", "Vanmassenhove et al. 2021", "Toral 2019"]} />. Current large
        language models still translate literary text more literally and with less variety than people do{" "}
        <Cite refs={["Zhang et al. 2025"]} />, and the outputs of different AI translation systems are more alike
        among themselves than human translations are <Cite refs={["Shterionov et al. 2026"]} />. Quality also drops
        for non-standard input, for example standard Finnish against Kven, a related Finnic variety{" "}
        <Cite refs={["Kantharuban et al. 2023"]} />. Not everything disappears: a speaker&apos;s variety can still be
        identified after translation <Cite refs={["Nisioi et al. 2022"]} />.
      </>
    ),
  },
  {
    title: "Speech recognition is built around the standard",
    body: (
      <>
        Off-the-shelf speech recognition is typically trained to output standard language{" "}
        <Cite refs={["Kuparinen 2025"]} />. The Finnish Parliament corpus, a major training resource, uses reference
        transcripts rewritten into standard written forms (<i>me mennään</i> becomes <i>me menemme</i>). Models trained
        on it reach about 6% word error rate on parliament speech and about 57% on everyday spoken Finnish{" "}
        <Cite refs={["Virkkunen et al. 2023"]} />. Spoken Finnish has no fixed spelling, so even human transcribers
        disagree <Cite refs={["Moisio et al. 2023"]} />, and a plain error rate against a standard reference is not a
        neutral measure <Cite refs={["Enarvi et al. 2017", "Kuparinen 2025"]} />. Internationally, recognition errors
        are higher for regional and ethnic varieties{" "}
        <Cite refs={["Koenecke et al. 2020", "Tatman 2017", "Feng et al. 2024", "Markl 2022"]} />.
      </>
    ),
  },
  {
    title: "A written transcript cannot carry the voice",
    body: (
      <>
        In a chain of recognition, translation and synthesis, the text in the middle drops intonation, timing and voice
        quality. Speech translation systems make little use of prosody even when it changes the meaning{" "}
        <Cite refs={["Tsiamas et al. 2024", "Sperber & Paulik 2020"]} />. Work on &quot;expressive&quot; speech
        translation measures voice similarity and prosody, not dialect or register, and does not cover Finnish{" "}
        <Cite refs={["Seamless 2023"]} />. Keeping a speaker&apos;s voice is not the same as keeping how they speak.
      </>
    ),
  },
  {
    title: "Language technology already treats non-standard speech unequally",
    body: (
      <>
        Language models answer speakers of non-standard English varieties with more stereotyping and condescension{" "}
        <Cite refs={["Fleisig et al. 2024"]} /> and hold covert negative stereotypes about dialect speakers{" "}
        <Cite refs={["Hofmann et al. 2024"]} />. Text rewritten with language models loses stylistic variation between
        authors <Cite refs={["Sourati et al. 2026"]} />. Synthetic voice services perform unequally across accents,
        and users describe the result as &quot;not a representation of me&quot; <Cite refs={["Michel et al. 2025"]} />.
        The accent of a synthetic voice changes how listeners judge it{" "}
        <Cite refs={["Tamagawa et al. 2011", "Cohn & Zellou 2020"]} />, and voice interfaces use a narrow, uniform set of
        voices <Cite refs={["Sutton et al. 2019"]} />. The field has been asked to say who is harmed and how, instead of
        speaking of bias in general <Cite refs={["Blodgett et al. 2020", "Hutiri et al. 2024", "Bird 2020"]} />.
      </>
    ),
  },
];

const OBJECTIVES = [
  "Collect a consented corpus of spontaneous spoken Finnish from adults of different regions, using the same communicative situations for everyone.",
  "Give every accepted recording four Finnish text versions (A, A*, B, C) with a full revision history.",
  "Translate every version under two instructions and synthesize every translation with one fixed voice, recording the exact model, prompt and settings of each run.",
  "Code what happened to each feature of the source, with categories taken from translation studies, by two coders on a shared subset.",
  "In a later phase, have source speakers, bilingual experts and English-speaking listeners evaluate the outputs.",
  "Release the method, code and annotation scheme, and share the recordings under controlled access.",
];

const HYPOTHESES: ReactNode[][] = [
  [
    <b key="h">H1 Recognition</b>,
    "Speech recognition keeps only part of the colloquial and regional forms. Compared with B, A will contain standard written forms where the speaker used other forms, and how much differs by feature and region.",
    <Cite key="c" refs={["Kuparinen 2025", "Virkkunen et al. 2023", "Radford et al. 2022"]} />,
    "Forms are kept in A* nearly as often as in B, for every feature and region.",
  ],
  [
    <b key="h">H2 Translation (core)</b>,
    "With the default instruction, the English translations of B (forms kept) and C (forms standardized) differ little in register, stance and discourse marking. The translation step neutralizes most of what B adds.",
    <Cite key="c" refs={["Toury 1995", "Leppihalme 2000", "Vanmassenhove et al. 2019", "Zhang et al. 2025"]} />,
    "Translations of B differ systematically from translations of C, in the direction of the source.",
  ],
  [
    <b key="h">H3 Preservation instruction</b>,
    "The preservation-aware instruction keeps more of the register, stance, discourse particles and emphasis than the default instruction, while meaning fidelity is no worse beyond a margin fixed before the analysis.",
    <Cite key="c" refs={["Sennrich et al. 2016", "Nădejde et al. 2022"]} />,
    "No difference between the instructions, or a gain only at a loss of meaning.",
  ],
  [
    <b key="h">H4 Invention</b>,
    "The preservation-aware instruction also adds social colour that the source does not support, more often than the default. Translations of C, which has no regional forms, are the check.",
    <Cite key="c" refs={["Fleisig et al. 2024", "Robinson et al. 2026", "Berezowski 1997"]} />,
    "Unsupported additions in translations of C are as rare with the preservation instruction as with the default.",
  ],
  [
    <b key="h">H5 Speech generation (later phase)</b>,
    "With the English wording held constant, synthesis choices change the perceived stance and social impression, and one neutral voice is heard as socially standard.",
    <Cite key="c" refs={["Tamagawa et al. 2011", "Cohn & Zellou 2020", "Székely et al. 2024"]} />,
    "Listeners' judgments do not change between synthesis conditions.",
  ],
  [
    <b key="h">H6 Representation (later phase)</b>,
    "Source speakers rate translations as less representative of how they speak than the meaning-fidelity ratings suggest: accurate is not the same as faithful to the person.",
    <Cite key="c" refs={["Eckert 2008", "Michel et al. 2025", "Markl 2022"]} />,
    "Representation ratings follow fidelity ratings closely.",
  ],
];

export function ScientificRelevance() {
  return (
    <div className="max-w-5xl space-y-10">
      <PageHeading
        title="Scientific Relevance"
        description="The research plan behind this platform: motivation, questions, hypotheses, method and expected contribution."
      />

      <Card className="border-amber-200 bg-amber-50">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="warning">Planned study</Badge>
          <p className="text-sm text-slate-800">
            This page describes a study that will be carried out. It reports no results. The hypotheses are expectations
            the design is built to test, and each can be refuted. Trial and demo runs on this platform are not research
            data.
          </p>
        </div>
      </Card>

      <Section id="sr-brief" title="In brief">
        <Card>
          <Prose>
            <p>
              When two people talk through AI speech translation, the system hears the speech, writes it down,
              translates the text and speaks it again in another language. Each step can change not only what was said
              but how it was said: casual or formal, hesitant or sure, local or neutral.
            </p>
            <p>
              This project asks <b>where in that chain the way a person speaks Finnish is kept, reformulated,
              standardized or distorted on its way into English</b>, and whether a translation instruction written to
              preserve it does better without losing meaning. The answer matters to anyone who will be represented to
              others by a machine, and to the people who design these systems.
            </p>
          </Prose>
        </Card>
      </Section>

      <Section id="sr-motivation" title="Motivation" description="Why this matters, and who has shown it.">
        <div className="grid gap-4 md:grid-cols-2">
          {MOTIVATION.map((item) => (
            <Card key={item.title} as="article">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">{item.title}</h3>
              <p className="text-sm leading-6 text-slate-700">{item.body}</p>
            </Card>
          ))}
          <Card as="article" className="border-blue-200 bg-blue-50 md:col-span-2">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">The gap this study fills</h3>
            <p className="text-sm leading-6 text-slate-700">
              Each piece is known on its own: human translation standardizes, machine translation reduces richness,
              recognition favours the standard, transcripts drop the voice. What is missing is evidence on{" "}
              <b>where, inside one real speech translation chain, the way present-day Finnish speakers talk is lost,
              kept or reshaped</b>. Comparisons of whole recognition, translation and synthesis chains exist for other
              languages <Cite refs={["Popescu-Belis et al. 2025"]} />. Finnish research so far converts dialect into standard Finnish{" "}
              <Cite refs={["Partanen et al. 2019", "Kuparinen & Scherrer 2023"]} />, transcribes dialect{" "}
              <Cite refs={["Kuparinen 2025"]} />, identifies it <Cite refs={["Hämäläinen et al. 2021"]} />, or evaluates
              translation of short standard sentences <Cite refs={["Luukkonen et al. 2025"]} />. Our literature check
              found no published study that measures what current translation systems do to colloquial or regional
              Finnish speech translated into English, and none in which speakers rate the machine translation of their
              own dialect speech.
            </p>
          </Card>
        </div>
      </Section>

      <Section id="sr-aims" title="Aim, goals and objectives">
        <Card>
          <Prose>
            <p>
              <b>Aim.</b> To find out whether, where and how Finnish to English AI speech translation keeps,
              reformulates, standardizes or distorts the way people speak, and whether translation can be instructed to
              do better.
            </p>
            <p>
              <b>Goals.</b> Scientifically, a stage-by-stage account of what speech translation does to linguistic
              variation. Methodologically, a reusable research instrument in which every output traces back to its
              source recording, prompt and model. For society, evidence that designers and users can act on about when
              AI translation misrepresents speakers.
            </p>
            <p>
              <b>Objectives.</b>
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              {OBJECTIVES.map((objective) => (
                <li key={objective}>{objective}</li>
              ))}
            </ol>
          </Prose>
        </Card>
      </Section>

      <Section id="sr-rq" title="Research questions">
        <Table
          head={["", "Question", "On this platform"]}
          rows={[
            [
              <b key="q">RQ1</b>,
              "At which stages of Finnish to English AI speech translation are selected dialectal, pragmatic and stylistic distinctions retained, functionally reformulated, normalized or distorted?",
              <Badge key="s" variant="completed">Data collection built</Badge>,
            ],
            [
              <b key="q">RQ2</b>,
              "Does preservation-aware translation retain more communicatively relevant variation than default translation, without reducing semantic fidelity or naturalness?",
              <Badge key="s" variant="completed">Data collection built</Badge>,
            ],
            [
              <b key="q">RQ3</b>,
              "When the translated wording is held constant, how do speech generation choices affect prosody, stance, emotion and speaker characteristics?",
              <Badge key="s" variant="neutral">Later phase</Badge>,
            ],
            [
              <b key="q">RQ4</b>,
              "How do source speakers, bilingual evaluators and target-language listeners perceive the representational adequacy and social meaning of AI-translated speech?",
              <Badge key="s" variant="neutral">Later phase</Badge>,
            ],
          ]}
        />
      </Section>

      <Section
        id="sr-hypotheses"
        title="Hypotheses"
        description="Written before any data exist. They will be preregistered with exact measures and margins. A result against any of them is a finding, not a failure."
      >
        <Table head={["", "Expectation", "Grounds", "What would refute it"]} rows={HYPOTHESES} />
      </Section>

      <Section id="sr-method" title="Methodology">
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Design: change one step at a time</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-700" aria-label="The pipeline">
            {["Finnish speech", "Speech recognition", "Finnish text", "Translation", "English text", "Speech synthesis", "English speech"].map(
              (step, index, all) => (
                <span key={step} className="flex items-center gap-2">
                  <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1">{step}</span>
                  {index < all.length - 1 && <span aria-hidden="true">→</span>}
                </span>
              ),
            )}
          </div>
          <Prose>
            <p className="mt-4">
              Each recording passes through the chain several times with exactly one thing changed: the Finnish text
              given to the translator, or the translation instruction. Differences between the outputs can then be
              attributed to that one change. During the session participants never see a transcript, translation,
              synthetic voice or model name, because AI output shown during speaking would change how people speak next.
            </p>
          </Prose>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Participants</h3>
          <Prose>
            <p>
              <b>Pilot:</b> two regional recruitment groups, three speakers each, two short clips per speaker, to test
              the tasks and refine the coding scheme. <b>Main study (planning proposal):</b> about 60 adults in four
              regional recruitment groups of about 15, recruited across localities and backgrounds. Final numbers are
              set by simulation from the variability seen in the pilot. A group is a recruitment category, not a claim
              that everyone in it speaks alike: each speaker&apos;s actual forms are coded, and their own description of
              their Finnish is asked only after the speaking tasks.
            </p>
          </Prose>
        </Card>

        <Card>
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Speaking tasks</h3>
          <Table
            head={["Task family", "What the participant does", "Why"]}
            rows={[
              [
                "Controlled",
                "Responds in their own words to the same situation as everyone else, for example an invitation they are unsure about. Nobody reads a Finnish sentence aloud.",
                "Comparable across speakers while the speech stays spontaneous.",
              ],
              [
                "Semi-structured",
                "Answers an open question, with follow-up questions written in advance by the researchers.",
                "Natural talk with some comparability. No model chooses the follow-ups.",
              ],
              ["Free speech", "Talks about anything for a minute or two.", "Rich, natural material. Exploratory only, never the main evidence."],
            ]}
          />
        </Card>

        <Card>
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Four Finnish versions of every recording</h3>
          <Table
            head={["", "What it is", "Made by"]}
            rows={[
              [<b key="v">A</b>, "What the speech recognition wrote, stored exactly as returned.", "The model"],
              [<b key="v">A*</b>, "A with the misheard words corrected, but the system's own standardizing left in place.", "A researcher"],
              [<b key="v">B</b>, "What the person actually said, in the form they said it, following the study's transcription conventions.", "A researcher, listening to the audio"],
              [<b key="v">C</b>, "B with selected regional and colloquial forms turned into standard Finnish, nothing else changed.", "A researcher, from B"],
            ]}
          />
          <div className="mt-4">
            <Table
              head={["Comparison", "What it isolates"]}
              rows={[
                ["A against A*", "How much the recognition simply misheard."],
                ["A* against B", "How much the recognition standardized forms the speaker really used."],
                ["Translation of B against translation of C", "Whether the translation step does anything with those forms, or neutralizes them (H2)."],
                ["Default against preservation instruction, same input", "Whether an explicit instruction helps (H3), and whether it invents (H4)."],
              ]}
            />
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            B and C are not generated by a language model in the research data: B is the reference for what was said,
            and a model-made reference would carry the same standardizing tendency the study measures.
          </p>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">The speaker reviews their own output</h3>
          <Prose>
            <p>
              After every speaking task and the first questionnaires, participants see their own recordings again,
              one page per recording. They hear the recording, read the speech recognition text and answer &quot;Is
              this what you said?&quot; (yes, partly, no). Below it the two English versions are shown side by side,
              labelled only Version 1 and Version 2, with the left and right placement random. Under each version
              there are two questions: how well the English says what they meant, and how much of the way they said it
              (tone, how casual they were, their own expressions) comes through. Both are 5-point scales with every
              point labelled, plus &quot;I can&apos;t say&quot;. The step combines established methods: stimulated
              recall, in which people review a record of their own performance right after it{" "}
              <Cite refs={["Lyle 2003"]} />, and member checking, in which participants review how their words were
              recorded <Cite refs={["Birt et al. 2016"]} />. The closest precedent had speakers rate AI clones of their
              own voice <Cite refs={["Michel et al. 2025"]} />.
            </p>
            <p>
              Showing the output only after the last task protects the speech data: people change how they speak once
              a system has misrecognized them <Cite refs={["Mengesha et al. 2021"]} />. The two versions are compared
              side by side because comparative judgements of two outputs are more reliable than rating each alone{" "}
              <Cite refs={["Song et al. 2025"]} />. Meaning and representation are separate questions, because readers
              who cannot check the meaning respond to fluency rather than accuracy{" "}
              <Cite refs={["Martindale & Carpuat 2018", "Zouhar et al. 2021"]} />; the background questionnaire therefore
              asks how well the participant understands written English. The page has only these questions, since
              answers become faster and less careful as a questionnaire grows longer{" "}
              <Cite refs={["Galesic & Bosnjak 2009"]} />. The part can be skipped at any point, and the debrief says
              that recognition errors are a limitation of the systems, not of the speaker.
            </p>
          </Prose>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Translation and speech synthesis</h3>
          <Prose>
            <p>
              <b>Default instruction:</b> &quot;Translate the following Finnish utterance into natural spoken English.
              Preserve its meaning. Return only the translation.&quot; It is deliberately ordinary, but it still asks for
              natural speech and fidelity, so that the other instruction cannot win just by being a better brief.
            </p>
            <p>
              <b>Preservation-aware instruction:</b> keep the meaning and the communicatively relevant differences in
              register, informality, stance, politeness, discourse organization, idiomatic force, humour and emphasis,
              with natural English means; do not assign the speaker a named English regional dialect, do not add
              stereotypical dialect markers, and do not invent information, emotion or social meaning.
            </p>
            <p>
              Each version (A, A*, B, C) is translated under each instruction as a separate, versioned model run.
              Every translation is spoken by <b>one fixed voice, model and instruction</b>, so that differences in the
              English audio come from the text and not from a change of voice. Whether the voice itself changes the
              impression is a separate, later experiment (RQ3).
            </p>
          </Prose>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Coding and measures</h3>
          <Prose>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>Transcript differences</b> are coded as recognition error, normalization, omission, addition,
                segmentation, punctuation or formatting, or uncertain.
              </li>
              <li>
                <b>What happened to each source feature in translation</b>: retained, functionally reformulated,
                compensated elsewhere, neutralized, distorted, exaggerated or invented, not transferable, or uncertain.
                The categories follow translation-strategy typologies{" "}
                <Cite refs={["Berezowski 1997", "Rosa 2012", "Ramos Pinto 2018"]} />. The list of Finnish features to
                code starts from variables used in current Finnish dialect research{" "}
                <Cite refs={["Kuparinen & Vaattovaara 2025"]} />.
                &quot;Not transferable&quot; is not counted as an error.
              </li>
              <li>
                <b>Recognition accuracy</b> as character error rate against both B and C, because a single standard
                reference is not neutral for spoken Finnish <Cite refs={["Kuparinen 2025", "Enarvi et al. 2017"]} />.
              </li>
              <li>
                <b>Meaning fidelity</b> by expert error annotation <Cite refs={["Lommel et al. 2014", "Freitag et al. 2021"]} />.
                Automatic metrics only support it, since they are not robust to dialect <Cite refs={["Sun et al. 2023"]} />.
              </li>
              <li>
                Fidelity, naturalness, representational adequacy, formality, stance, regional association and voice
                similarity are kept as <b>separate measures</b>. There is no single &quot;dialect score&quot;.
              </li>
              <li>
                <b>Who judges what.</b> Only the speaker can say whether a version represents what they meant and how
                they said it, so representation rated by the speaker is the primary outcome of the review. Whether the
                English is accurate is also rated by independent bilingual experts, with the speaker&apos;s own rating of
                their English reading as a moderator <Cite refs={["Martindale & Carpuat 2018"]} />.
              </li>
            </ul>
          </Prose>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Analysis</h3>
          <Prose>
            <p>
              Mixed-effects models with crossed random effects for speaker and item (and listener in the later
              evaluation): logistic models for whether a feature was retained, ordinal models for ratings. A development
              sample is coded by two people, the codebook is revised, and a substantial evaluation subset is coded
              independently, with an agreement statistic suited to each scale. Original disagreements are kept, not
              averaged away. Each speaker stays within one data split, because speaker effects can strongly distort
              dialect identification, even if transcription is far less affected <Cite refs={["Kuparinen 2026"]} />. Analysis runs on exported data with scripts, never on a dashboard during collection, so that
              nobody stops or changes the study after a peek at the outcomes.
            </p>
          </Prose>
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Ethics and data protection</h3>
          <Prose>
            <p>
              Voice recordings are personal data, and biometric data when processed to identify a person{" "}
              <Cite refs={["EDPB 2021", "Nautsch et al. 2019"]} />. The study follows the institution&apos;s ethics
              review and data protection procedures. Consent is versioned, with separate items for recording, external
              AI processing and later reuse. AI providers receive only the audio or text and the instruction, never a
              participant code, region or questionnaire answer. A Finnish precedent for the legal basis of a speech
              corpus exists <Cite refs={["Moisio et al. 2023"]} />. The dataset will be documented with a data statement{" "}
              <Cite refs={["Bender & Friedman 2018"]} />. Audio is never publicly addressable.
            </p>
          </Prose>
        </Card>
      </Section>

      <Section id="sr-results" title="What the results will be able to show">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">The data can show</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">
              <li>at which step a given feature of how someone spoke was lost, kept or changed;</li>
              <li>what kind of change it was: neutralized, reformulated, compensated, distorted or invented;</li>
              <li>whether an explicit instruction keeps more, and at what cost to meaning;</li>
              <li>how this differs by feature, task and recruitment region;</li>
              <li>in the later phase, whether being accurate and being faithful to the person come apart.</li>
            </ul>
          </Card>
          <Card>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">It cannot show</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">
              <li>
                that Finnish dialects are disappearing in society: that needs long-term evidence about how people speak,
                not about machine output;
              </li>
              <li>anything about all translation systems: each batch names one provider, model and date;</li>
              <li>that standardizing is always a loss: some forms have no English equivalent;</li>
              <li>causal effects from free speech alone.</li>
            </ul>
          </Card>
        </div>
      </Section>

      <Section id="sr-discussion" title="Expected discussion">
        <Card>
          <Prose>
            <p>
              <b>Where the fix belongs.</b> If the forms are lost mainly in recognition, the issue is training data and
              transcription conventions, not translation. Finnish training resources that rewrite speech into the written
              standard do this by design <Cite refs={["Virkkunen et al. 2023"]} />. If the forms survive recognition and
              are lost in translation, the issue is instruction and model design. Locating the step turns a general
              worry into a concrete engineering target.
            </p>
            <p>
              <b>What keeping a dialect can mean across languages.</b> Finnish forms cannot be copied into English. The
              defensible target is functional, keeping register, stance and the rhythm of talk without relocating the
              speaker into an English region. The discussion will connect the coded outcomes to translation-strategy
              typologies <Cite refs={["Berezowski 1997", "Rosa 2012"]} /> and to the risk of stereotype{" "}
              <Cite refs={["Fleisig et al. 2024"]} />.
            </p>
            <p>
              <b>The written standard inside the tools.</b> Finland&apos;s long norm that speech should follow writing{" "}
              <Cite refs={["Nuolijärvi & Vaattovaara 2011"]} /> meets systems trained mostly on written standard
              language. The discussion will ask whether AI mediation renews that norm in personal communication, without
              claiming that it changes how people speak. That people adapt their own speech to AI voices over the long
              term has been argued but not yet shown <Cite refs={["Székely et al. 2025"]} />.
            </p>
            <p>
              <b>Whose judgment counts.</b> Experts judge accuracy, speakers judge representation, listeners form
              impressions. Where they disagree, the disagreement is a result to explain, not noise{" "}
              <Cite refs={["Blodgett et al. 2020"]} />.
            </p>
            <p>
              <b>Limits.</b> One language pair, one provider and model generation per batch, a modest number of speakers,
              recordings made in a study setting, and models that providers update (every run logs the model actually
              used).
            </p>
          </Prose>
        </Card>
      </Section>

      <Section id="sr-conclusion" title="Provisional conclusion" description="Written before any data exist: the conclusion the design is built to reach or to overturn.">
        <Card className="border-slate-300">
          <Prose>
            <p>
              AI speech translation can deliver what Finnish speakers say while quietly rewriting how they say it, and
              the losses can be traced to specific steps of the chain. If the expected pattern holds, some
              standardizing happens already in recognition and most of it in translation, and a carefully written
              instruction recovers part of it without inventing a new identity for the speaker. If the pattern does not
              hold, the same design shows which distinctions survive, where and why.
            </p>
            <p>
              Either way the contribution stands: a method that shows where meaning about a person is lost in AI
              mediation, a Finnish corpus in which every output traces back to its source, and evidence that designers
              of speech translation can act on.
            </p>
          </Prose>
        </Card>
      </Section>

      <Section id="sr-platform" title="Where this happens on the platform">
        <Table
          head={["Step of the study", "Admin page"]}
          rows={[
            ["Tasks, consent, instructions, questionnaires (versioned)", <Link key="l" className="underline" href="/admin/study-flow">Study Flow</Link>],
            ["Follow collection and inspect every recording and output", <Link key="l" className="underline" href="/admin/sessions">Sessions</Link>],
            ["Write and verify A*, B and C; code differences", <Link key="l" className="underline" href="/admin/review">Review & Transcription</Link>],
            ["The two translation instructions, models and voice (versioned)", <Link key="l" className="underline" href="/admin/ai-pipeline">AI Pipeline</Link>],
            ["Run translation and synthesis on a fixed selection", <Link key="l" className="underline" href="/admin/processing">Processing Runs</Link>],
            ["Export the dataset with its full provenance", <Link key="l" className="underline" href="/admin/data">Data & Export</Link>],
          ]}
        />
      </Section>

      <Section id="sr-references" title="References" description="Every source was checked on a publisher, archive or DOI page on 2026-10-09.">
        <Card>
          <ol className="space-y-2 text-sm leading-6 text-slate-700">
            {REFERENCES.map((ref) => (
              <li key={ref.key} id={referenceAnchor(ref.key)} className="scroll-mt-6">
                {ref.citation}{" "}
                <a href={ref.url} target="_blank" rel="noopener noreferrer" className="break-all text-blue-700 underline">
                  {ref.url.replace(/^https?:\/\//, "")}
                </a>
                {ref.note && <span className="text-slate-500"> {ref.note}</span>}
              </li>
            ))}
          </ol>
        </Card>
      </Section>
    </div>
  );
}

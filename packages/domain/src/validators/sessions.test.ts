import { describe, expect, it } from "vitest";
import { INPUT_DEVICE_CLASSES } from "../enums";
import {
  audioEnvironmentSchema,
  captureMetadataSchema,
  classifyInputDevice,
  stripDeviceIdentifiers,
  toInputDeviceClass,
} from "./sessions";

describe("classifyInputDevice", () => {
  it("turns a device label into a coarse class", () => {
    expect(classifyInputDevice("Anna Virtasen AirPods Pro")).toBe("bluetooth");
    expect(classifyInputDevice("Headset (WH-1000XM4 Hands-Free AG Audio) (Bluetooth)")).toBe("bluetooth");
    expect(classifyInputDevice("Jabra Evolve 40 Headset")).toBe("headset");
    expect(classifyInputDevice("Microphone (HD Pro Webcam C920) (046d:082d)")).toBe("usb");
    expect(classifyInputDevice("USB Audio Device")).toBe("usb");
    expect(classifyInputDevice("MacBook Pro Microphone (Built-in)")).toBe("built_in");
    expect(classifyInputDevice("Internal Microphone")).toBe("built_in");
    expect(classifyInputDevice("Sisäinen mikrofoni")).toBe("built_in");
  });

  it("answers unknown for a label it does not recognize, and for no label", () => {
    expect(classifyInputDevice("Default")).toBe("unknown");
    expect(classifyInputDevice("External Microphone")).toBe("unknown");
    expect(classifyInputDevice("")).toBe("unknown");
    expect(classifyInputDevice(null)).toBe("unknown");
    expect(classifyInputDevice(undefined)).toBe("unknown");
  });
});

describe("toInputDeviceClass", () => {
  it("keeps a class and classifies any other text, so a raw label is never kept", () => {
    for (const deviceClass of INPUT_DEVICE_CLASSES) expect(toInputDeviceClass(deviceClass)).toBe(deviceClass);
    expect(toInputDeviceClass("Anna Virtasen AirPods Pro")).toBe("bluetooth");
    expect(toInputDeviceClass("Matti's microphone")).toBe("unknown");
  });
});

describe("device identifiers in the request schemas", () => {
  const identifiers = { deviceId: "a1b2c3d4e5f6", groupId: "0f9e8d7c6b5a" };

  it("stripDeviceIdentifiers removes deviceId and groupId and keeps the rest", () => {
    expect(stripDeviceIdentifiers({ ...identifiers, sampleRate: 48000 })).toEqual({ sampleRate: 48000 });
  });

  it("the capture metadata of an upload never carries device identifiers or a raw label", () => {
    const parsed = captureMetadataSchema.parse({
      deviceLabel: "Anna Virtasen AirPods Pro",
      actualTrackSettings: { ...identifiers, sampleRate: 48000, channelCount: 1 },
      requestedConstraints: { deviceId: { ideal: "a1b2c3d4e5f6" }, channelCount: 1 },
    });
    expect(parsed.deviceLabel).toBe("bluetooth");
    expect(parsed.actualTrackSettings).toEqual({ sampleRate: 48000, channelCount: 1 });
    expect(parsed.requestedConstraints).toEqual({ channelCount: 1 });
    expect(JSON.stringify(parsed)).not.toMatch(/a1b2c3d4e5f6|0f9e8d7c6b5a|Virtasen/);
  });

  it("the audio environment of the microphone check never carries them either", () => {
    const parsed = audioEnvironmentSchema.parse({
      deviceLabel: "Internal Microphone",
      actualTrackSettings: { ...identifiers, echoCancellation: false },
    });
    expect(parsed).toEqual({ deviceLabel: "built_in", actualTrackSettings: { echoCancellation: false } });
  });
});

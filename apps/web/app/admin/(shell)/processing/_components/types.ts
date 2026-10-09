// JSON shapes of the Processing Runs API as the browser receives them: the
// service types with every date as ISO 8601 text.
import type { processing } from "@dialect/research";

type Serialized<T> = T extends Date
  ? string
  : T extends Array<infer Item>
    ? Array<Serialized<Item>>
    : T extends object
      ? { [Key in keyof T]: Serialized<T[Key]> }
      : T;

export type BatchSummary = Serialized<processing.BatchSummary>;
export type BatchDetail = Serialized<processing.BatchDetail>;
export type BatchJob = Serialized<processing.BatchJobView>;
export type BatchList = Serialized<processing.ListBatchesResult>;
export type BatchJobList = Serialized<processing.ListBatchJobsResult>;
export type BatchOptions = Serialized<processing.BatchOptions>;
export type BatchConfigOption = BatchOptions["modelConfigs"][number];
export type BatchConfigLabel = BatchSummary["config"]["translations"][number];
export type ConfigSnapshot = BatchDetail["configuration"]["translations"][number];

// The preview leaves out the list of utterance ids and reports their number.
export type BatchPreview = Omit<Serialized<processing.BatchPreview>, "configuration"> & {
  configuration: Omit<BatchDetail["configuration"], "utteranceIds"> & { utteranceCount: number };
};

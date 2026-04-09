/**
 * Jobs index config — settings + mappings for the jobs OpenSearch index.
 * Fields match the output of jobs-transform in example/indexes/jobs/transform.ex.
 */
import defaults from "../../opensearch/_defaults.ts";

export default {
  ...defaults,
  mappings: {
    dynamic: "strict",
    properties: {
      id: { type: "keyword" },
      title: {
        type: "text",
        fields: {
          ngram: { type: "text", analyzer: "ngram" },
        },
      },
      slug: { type: "keyword" },
      divisionId: { type: "keyword" },
      phaseId: { type: "keyword" },
      contactId: { type: "keyword" },
      expectedOrderAmount: { type: "float" },
      invoiceTotalAmount: { type: "float" },
      showInKanban: { type: "boolean" },
      finishedAt: { type: "date" },
      cancelledAt: { type: "date" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      division: {
        type: "object",
        properties: {
          name: { type: "text" },
        },
      },
    },
  },
};

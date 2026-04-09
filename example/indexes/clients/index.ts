/**
 * Clients index config — settings + mappings for the clients OpenSearch index.
 * Fields match the output of clients-transform in example/indexes/clients/transform.ex.
 */
import defaults from "../../opensearch/_defaults.ts";

export default {
  ...defaults,
  mappings: {
    properties: {
      id: { type: "keyword" },
      name: {
        type: "text",
        fields: {
          ngram: { type: "text", analyzer: "ngram" },
        },
      },
      companyName: { type: "text" },
      phone: { type: "keyword" },
      email: { type: "keyword" },
      isCompany: { type: "boolean" },
      isArchive: { type: "boolean" },
      divisionId: { type: "keyword" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
};

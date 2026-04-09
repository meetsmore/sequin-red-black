/**
 * Shared OpenSearch index settings.
 * All index configs import this and spread it as a base.
 */
export default {
  settings: {
    index: { max_result_window: 100000 },
    analysis: {
      analyzer: {
        ngram: {
          type: "custom",
          tokenizer: "ngram_tokenizer",
          filter: ["lowercase"],
        },
      },
      tokenizer: {
        ngram_tokenizer: {
          type: "ngram",
          min_gram: 2,
          max_gram: 3,
        },
      },
    },
  },
};

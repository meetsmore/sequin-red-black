module srb {

  // A "red-blackified" group of sink/index/enrichment/transformation.
  type ManagedNode = {
    // The name of the node: "jobs_red"
    name: str, 
    // The Sequin sink: "jobs_red_sink"
    sink: str,
    // The OpenSearch index: "jobs_red"
    index: str,
    // The Sequin enrichment function. "jobs_red_enrichment"
    enrichment: str,
    // The Sequin transformation function. "jobs_red_transformation"
    transformation: str
  }

  // Defines a resource and any current managed nodes that relate to it.
  // A resource might be "jobs" and the managed nodes might be "jobs_red" or "jobs_black" and the associated resources.
  type Node = {
    base: str,
    nodes: Set[ManagedNode]
  }

  pure val sinks = Set();
  pure val indexes = Set();
  pure val enrichments = Set();
  pure val transformations = Set();
  
}
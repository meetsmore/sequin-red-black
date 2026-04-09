def transform(_action, record, _changes, metadata) do
  enrich = metadata.enrichment || %{}

  %{
    "id" => record["id"],
    "title" => record["title"],
    "slug" => record["slug"],
    "divisionId" => record["divisionId"],
    "phaseId" => record["phaseId"],
    "contactId" => record["contactId"],
    "expectedOrderAmount" => record["expectedOrderAmount"],
    "invoiceTotalAmount" => record["invoiceTotalAmount"],
    "showInKanban" => record["showInKanban"],
    "finishedAt" => record["finishedAt"],
    "cancelledAt" => record["cancelledAt"],
    "createdAt" => record["createdAt"],
    "updatedAt" => record["updatedAt"],
    "division" => enrich["division"]
  }
end

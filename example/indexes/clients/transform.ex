def transform(_action, record, _changes, metadata) do
  %{
    "id" => record["id"],
    "name" => record["name"],
    "companyName" => record["companyName"],
    "phone" => record["phone"],
    "email" => record["email"],
    "isCompany" => record["isCompany"],
    "isArchive" => record["isArchive"],
    "divisionId" => record["divisionId"],
    "createdAt" => record["createdAt"],
    "updatedAt" => record["updatedAt"]
  }
end

import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// --- Types ---

type Row = Record<string, unknown>;

interface Division {
  id: number;
  name: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  column_default: string | null;
  is_nullable: string;
}

interface SearchHit {
  index: string;
  id: string;
  score: number;
  [key: string]: unknown;
}

interface IndexInfo {
  name: string;
  docsCount: number;
  health: string;
  status: string;
}

interface AliasInfo {
  name: string;
  indexes: string[];
}

// --- API helpers ---

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (res.status === 204) return undefined as T;
  return res.json();
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Extract column names that aren't in a known set, for dynamic "extra" columns. */
function extraColumns(row: Row, knownKeys: Set<string>): string[] {
  return Object.keys(row).filter(k => !knownKeys.has(k));
}

// --- Components ---

const JOBS_KNOWN = new Set(["id", "title", "slug", "divisionId", "division_name", "expectedOrderAmount", "showInKanban", "finishedAt", "cancelledAt", "phaseId", "contactId", "invoiceTotalAmount", "createdAt", "updatedAt"]);

function JobsTab({ divisions }: { divisions: Division[] }) {
  const [jobs, setJobs] = useState<Row[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Row>({});
  const [newJob, setNewJob] = useState<Row>({ title: "", slug: "", divisionId: "", expectedOrderAmount: "" });

  const load = useCallback(async () => {
    const rows = await api<Row[]>("/api/tables/Job");
    const divs = await api<Division[]>("/api/tables/Division");
    const divMap = Object.fromEntries(divs.map(d => [d.id, d.name]));
    setJobs(rows.map(r => ({ ...r, division_name: divMap[r.divisionId as number] ?? "" })));
  }, []);

  useEffect(() => { load(); }, [load]);

  const extras = jobs.length > 0 ? extraColumns(jobs[0], JOBS_KNOWN) : [];

  const startEdit = (job: Row) => {
    setEditId(job.id as number);
    setEditData({ ...job });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    const { division_name, ...data } = editData;
    await api(`/api/tables/Job/${editId}`, { method: "PUT", body: JSON.stringify(data) });
    setEditId(null);
    load();
  };

  const deleteJob = async (id: number) => {
    await api(`/api/tables/Job/${id}`, { method: "DELETE" });
    load();
  };

  const addJob = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Row = { ...newJob };
    body.expectedOrderAmount = parseFloat(body.expectedOrderAmount as string) || null;
    body.divisionId = parseInt(body.divisionId as string) || null;
    await api("/api/tables/Job", { method: "POST", body: JSON.stringify(body) });
    setNewJob({ title: "", slug: "", divisionId: "", expectedOrderAmount: "" });
    load();
  };

  const fmtAmount = (v: unknown) => v != null ? `¥${Number(v).toLocaleString()}` : "";

  return (
    <div>
      <h2>Jobs</h2>
      <form onSubmit={addJob} className="form-row">
        <input placeholder="Title" value={newJob.title as string} onChange={e => setNewJob({ ...newJob, title: e.target.value })} required />
        <input placeholder="Slug" value={newJob.slug as string} onChange={e => setNewJob({ ...newJob, slug: e.target.value })} />
        <input placeholder="Expected amount" type="number" value={newJob.expectedOrderAmount as string} onChange={e => setNewJob({ ...newJob, expectedOrderAmount: e.target.value })} />
        <select value={newJob.divisionId as string} onChange={e => setNewJob({ ...newJob, divisionId: e.target.value })}>
          <option value="">Division</option>
          {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button type="submit" className="btn-primary">Add</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>ID</th><th>Title</th><th>Slug</th><th>Division</th><th>Expected Amount</th><th>Kanban</th><th>Finished</th>
            {extras.map(c => <th key={c}>{c}</th>)}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr key={job.id as number}>
              {editId === (job.id as number) ? (
                <>
                  <td>{job.id as number}</td>
                  <td><input className="inline-input" value={editData.title as string ?? ""} onChange={e => setEditData({ ...editData, title: e.target.value })} /></td>
                  <td><input className="inline-input" value={editData.slug as string ?? ""} onChange={e => setEditData({ ...editData, slug: e.target.value })} /></td>
                  <td>
                    <select className="inline-input" value={formatCell(editData.divisionId)} onChange={e => setEditData({ ...editData, divisionId: parseInt(e.target.value) || null })}>
                      {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </td>
                  <td><input className="inline-input" type="number" value={formatCell(editData.expectedOrderAmount)} onChange={e => setEditData({ ...editData, expectedOrderAmount: parseFloat(e.target.value) || null })} /></td>
                  <td><input type="checkbox" checked={!!editData.showInKanban} onChange={e => setEditData({ ...editData, showInKanban: e.target.checked })} /></td>
                  <td>{formatCell(job.finishedAt)}</td>
                  {extras.map(col => (
                    <td key={col}><input className="inline-input" value={formatCell(editData[col])} onChange={e => setEditData({ ...editData, [col]: e.target.value })} /></td>
                  ))}
                  <td className="actions">
                    <button className="btn-primary btn-sm" onClick={saveEdit}>Save</button>
                    <button className="btn-ghost btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td>{job.id as number}</td>
                  <td>{job.title as string}</td>
                  <td style={{ fontSize: 12, color: "#888" }}>{job.slug as string}</td>
                  <td>{job.division_name as string}</td>
                  <td>{fmtAmount(job.expectedOrderAmount)}</td>
                  <td>{job.showInKanban ? "yes" : "no"}</td>
                  <td>{job.finishedAt ? "yes" : ""}</td>
                  {extras.map(col => (
                    <td key={col}>{formatCell(job[col])}</td>
                  ))}
                  <td className="actions">
                    <button className="btn-ghost btn-sm" onClick={() => startEdit(job)}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => deleteJob(job.id as number)}>Delete</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CLIENTS_KNOWN = new Set(["id", "name", "companyName", "phone", "email", "isCompany", "isArchive", "divisionId", "createdAt", "updatedAt"]);

function ClientsTab() {
  const [clients, setClients] = useState<Row[]>([]);
  const [editId, setEditId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Row>({});
  const [newClient, setNewClient] = useState<Row>({ name: "", companyName: "", phone: "", email: "", isCompany: false });

  const load = useCallback(async () => {
    setClients(await api<Row[]>("/api/tables/Client"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const extras = clients.length > 0 ? extraColumns(clients[0], CLIENTS_KNOWN) : [];

  const startEdit = (client: Row) => {
    setEditId(client.id as number);
    setEditData({ ...client });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    await api(`/api/tables/Client/${editId}`, { method: "PUT", body: JSON.stringify(editData) });
    setEditId(null);
    load();
  };

  const deleteClient = async (id: number) => {
    await api(`/api/tables/Client/${id}`, { method: "DELETE" });
    load();
  };

  const addClient = async (e: React.FormEvent) => {
    e.preventDefault();
    await api("/api/tables/Client", { method: "POST", body: JSON.stringify(newClient) });
    setNewClient({ name: "", companyName: "", phone: "", email: "", isCompany: false });
    load();
  };

  return (
    <div>
      <h2>Clients</h2>
      <form onSubmit={addClient} className="form-row">
        <input placeholder="Name" value={newClient.name as string} onChange={e => setNewClient({ ...newClient, name: e.target.value })} required />
        <input placeholder="Company name" value={newClient.companyName as string} onChange={e => setNewClient({ ...newClient, companyName: e.target.value })} />
        <input placeholder="Phone" value={newClient.phone as string} onChange={e => setNewClient({ ...newClient, phone: e.target.value })} />
        <input placeholder="Email" value={newClient.email as string} onChange={e => setNewClient({ ...newClient, email: e.target.value })} />
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14 }}>
          <input type="checkbox" checked={!!newClient.isCompany} onChange={e => setNewClient({ ...newClient, isCompany: e.target.checked })} />
          Company
        </label>
        <button type="submit" className="btn-primary">Add</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th>Corp</th><th>Archive</th>
            {extras.map(c => <th key={c}>{c}</th>)}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map(client => (
            <tr key={client.id as number}>
              {editId === (client.id as number) ? (
                <>
                  <td>{client.id as number}</td>
                  <td><input className="inline-input" value={editData.name as string ?? ""} onChange={e => setEditData({ ...editData, name: e.target.value })} /></td>
                  <td><input className="inline-input" value={editData.companyName as string ?? ""} onChange={e => setEditData({ ...editData, companyName: e.target.value })} /></td>
                  <td><input className="inline-input" value={editData.phone as string ?? ""} onChange={e => setEditData({ ...editData, phone: e.target.value })} /></td>
                  <td><input className="inline-input" value={editData.email as string ?? ""} onChange={e => setEditData({ ...editData, email: e.target.value })} /></td>
                  <td><input type="checkbox" checked={!!editData.isCompany} onChange={e => setEditData({ ...editData, isCompany: e.target.checked })} /></td>
                  <td><input type="checkbox" checked={!!editData.isArchive} onChange={e => setEditData({ ...editData, isArchive: e.target.checked })} /></td>
                  {extras.map(col => (
                    <td key={col}><input className="inline-input" value={formatCell(editData[col])} onChange={e => setEditData({ ...editData, [col]: e.target.value })} /></td>
                  ))}
                  <td className="actions">
                    <button className="btn-primary btn-sm" onClick={saveEdit}>Save</button>
                    <button className="btn-ghost btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td>{client.id as number}</td>
                  <td>{client.name as string}</td>
                  <td>{(client.companyName as string) || ""}</td>
                  <td>{(client.phone as string) || ""}</td>
                  <td>{(client.email as string) || ""}</td>
                  <td>{client.isCompany ? "yes" : "no"}</td>
                  <td>{client.isArchive ? "yes" : ""}</td>
                  {extras.map(col => (
                    <td key={col}>{formatCell(client[col])}</td>
                  ))}
                  <td className="actions">
                    <button className="btn-ghost btn-sm" onClick={() => startEdit(client)}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => deleteClient(client.id as number)}>Delete</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SearchTab() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(false);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [aliases, setAliases] = useState<AliasInfo[]>([]);

  const loadIndexes = useCallback(async () => {
    const data = await api<{ indexes: IndexInfo[]; aliases: AliasInfo[] }>("/api/indexes");
    setIndexes(data.indexes);
    setAliases(data.aliases);
    if (!selectedIndex && data.aliases.length > 0) {
      setSelectedIndex(data.aliases[0].name);
    }
  }, [selectedIndex]);

  useEffect(() => { loadIndexes(); }, [loadIndexes]);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim() || !selectedIndex) return;
    const data = await api<{ hits: SearchHit[]; total: number }>(`/api/search?q=${encodeURIComponent(query)}&index=${selectedIndex}`);
    setHits(data.hits);
    setTotal(data.total);
    setSearched(true);
  };

  // Derive columns dynamically from search results
  const hitColumns = hits.length > 0
    ? Object.keys(hits[0]).filter(k => !["index", "score"].includes(k))
    : [];

  return (
    <div>
      <h2>Search OpenSearch</h2>
      <form onSubmit={search} className="search-bar">
        <select value={selectedIndex} onChange={e => { setSelectedIndex(e.target.value); setSearched(false); setHits([]); }}>
          {aliases.length > 0 && (
            <optgroup label="Aliases">
              {aliases.map(a => (
                <option key={`alias-${a.name}`} value={a.name}>
                  {a.name} → {a.indexes.join(", ")}
                </option>
              ))}
            </optgroup>
          )}
          {indexes.length > 0 && (
            <optgroup label="Indexes">
              {indexes.map(i => (
                <option key={`idx-${i.name}`} value={i.name}>
                  {i.name} ({i.docsCount} docs)
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <input placeholder="Search..." value={query} onChange={e => setQuery(e.target.value)} />
        <button type="submit" className="btn-primary">Search</button>
      </form>

      {searched && (
        hits.length === 0 ? (
          <p className="empty">No results found.</p>
        ) : (
          <>
            <p style={{ marginBottom: 8, fontSize: 13, color: "#666" }}>{total} result{total !== 1 ? "s" : ""}</p>
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Index</th>
                  {hitColumns.map(c => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {hits.map((hit, i) => (
                  <tr key={i}>
                    <td><span className="score">{hit.score.toFixed(2)}</span></td>
                    <td style={{ fontSize: 12, color: "#888" }}>{hit.index}</td>
                    {hitColumns.map(c => <td key={c}>{formatCell(hit[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}
    </div>
  );
}

function MigrationsTab() {
  const [table, setTable] = useState<"Job" | "Client">("Job");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [log, setLog] = useState<Array<{ message: string; ok: boolean }>>([]);

  const [newCol, setNewCol] = useState({ column: "", columnType: "TEXT", defaultValue: "" });
  const [dropCol, setDropCol] = useState("");
  const [renameCol, setRenameCol] = useState("");
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");

  const loadSchema = useCallback(async () => {
    setColumns(await api<ColumnInfo[]>(`/api/schema/${table}`));
  }, [table]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  const droppableColumns = columns.filter(c => !["id", "createdAt", "updatedAt"].includes(c.column_name));
  const textLikeColumns = columns.filter(c => ["text", "character varying", "USER-DEFINED"].includes(c.data_type));

  useEffect(() => {
    setDropCol("");
    setRenameCol("");
    setFromValue("");
    setToValue("");
    setNewCol({ column: "", columnType: "TEXT", defaultValue: "" });
  }, [table]);

  const runMigration = async (body: Record<string, unknown>) => {
    const data = await api<{ ok?: boolean; message?: string; error?: string }>("/api/migrate", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setLog(prev => [{ message: data.message ?? data.error ?? "Done", ok: !!data.ok }, ...prev]);
    loadSchema();
  };

  const addColumn = async (e: React.FormEvent) => {
    e.preventDefault();
    await runMigration({ action: "add_column", table, ...newCol });
    setNewCol({ column: "", columnType: "TEXT", defaultValue: "" });
  };

  const dropColumn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dropCol) return;
    await runMigration({ action: "drop_column", table, column: dropCol });
    setDropCol("");
  };

  const renameValues = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameCol || !fromValue || !toValue) return;
    await runMigration({ action: "rename_values", table, column: renameCol, fromValue, toValue });
    setFromValue("");
    setToValue("");
  };

  return (
    <div>
      <h2>Migrations</h2>

      <div className="form-row" style={{ marginBottom: 20 }}>
        <select value={table} onChange={e => setTable(e.target.value as "Job" | "Client")}>
          <option value="Job">Job</option>
          <option value="Client">Client</option>
        </select>
      </div>

      <h3 style={{ fontSize: 14, marginBottom: 8, color: "#555" }}>Current Schema: {table}</h3>
      <table style={{ marginBottom: 24 }}>
        <thead>
          <tr><th>Column</th><th>Type</th><th>Default</th><th>Nullable</th></tr>
        </thead>
        <tbody>
          {columns.map(c => (
            <tr key={c.column_name}>
              <td style={{ fontFamily: "monospace" }}>{c.column_name}</td>
              <td style={{ fontFamily: "monospace" }}>{c.data_type}</td>
              <td style={{ fontFamily: "monospace", fontSize: 12 }}>{c.column_default ?? "—"}</td>
              <td>{c.is_nullable === "YES" ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="migration-actions">
        <div className="migration-card">
          <h3>Add Column</h3>
          <form onSubmit={addColumn} className="form-row">
            <input placeholder="Column name" value={newCol.column} onChange={e => setNewCol({ ...newCol, column: e.target.value })} required />
            <select value={newCol.columnType} onChange={e => setNewCol({ ...newCol, columnType: e.target.value })}>
              <option value="TEXT">TEXT</option>
              <option value="INTEGER">INTEGER</option>
              <option value="BOOLEAN">BOOLEAN</option>
              <option value="TIMESTAMPTZ">TIMESTAMPTZ</option>
              <option value="JSONB">JSONB</option>
            </select>
            <input placeholder="Default (optional)" value={newCol.defaultValue} onChange={e => setNewCol({ ...newCol, defaultValue: e.target.value })} />
            <button type="submit" className="btn-primary">Add</button>
          </form>
        </div>

        <div className="migration-card">
          <h3>Drop Column</h3>
          <form onSubmit={dropColumn} className="form-row">
            <select value={dropCol} onChange={e => setDropCol(e.target.value)} required>
              <option value="">Select column...</option>
              {droppableColumns.map(c => (
                <option key={c.column_name} value={c.column_name}>{c.column_name}</option>
              ))}
            </select>
            <button type="submit" className="btn-danger">Drop</button>
          </form>
        </div>

        <div className="migration-card">
          <h3>Rename Values</h3>
          <p style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Bulk-rename a value in a text column (e.g. status "open" → "active")</p>
          <form onSubmit={renameValues} className="form-row">
            <select value={renameCol} onChange={e => setRenameCol(e.target.value)} required>
              <option value="">Select column...</option>
              {textLikeColumns.map(c => (
                <option key={c.column_name} value={c.column_name}>{c.column_name}</option>
              ))}
            </select>
            <input placeholder="From value" value={fromValue} onChange={e => setFromValue(e.target.value)} required />
            <input placeholder="To value" value={toValue} onChange={e => setToValue(e.target.value)} required />
            <button type="submit" className="btn-primary">Rename</button>
          </form>
        </div>
      </div>

      {log.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8, color: "#555" }}>Migration Log</h3>
          <div className="migration-log">
            {log.map((entry, i) => (
              <div key={i} className={`log-entry ${entry.ok ? "log-ok" : "log-err"}`}>
                {entry.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<"jobs" | "clients" | "search" | "migrations">("jobs");
  const [divisions, setDivisions] = useState<Division[]>([]);

  useEffect(() => {
    api<Division[]>("/api/tables/Division").then(setDivisions);
  }, []);

  return (
    <div className="app">
      <h1>SRB Demo</h1>
      <div className="tabs">
        <button className={`tab ${tab === "jobs" ? "active" : ""}`} onClick={() => setTab("jobs")}>Jobs</button>
        <button className={`tab ${tab === "clients" ? "active" : ""}`} onClick={() => setTab("clients")}>Clients</button>
        <button className={`tab ${tab === "search" ? "active" : ""}`} onClick={() => setTab("search")}>Search</button>
        <button className={`tab ${tab === "migrations" ? "active" : ""}`} onClick={() => setTab("migrations")}>Migrations</button>
      </div>

      {tab === "jobs" && <JobsTab divisions={divisions} />}
      {tab === "clients" && <ClientsTab />}
      {tab === "search" && <SearchTab />}
      {tab === "migrations" && <MigrationsTab />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

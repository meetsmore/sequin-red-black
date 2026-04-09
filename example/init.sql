-- This runs against the default "sequin" database first,
-- then creates a separate "source" database for our CDC tables.
-- Table/column names use PascalCase/camelCase to match the meetsone schema.

-- Create the source database
CREATE DATABASE source;

-- Connect to source and set up tables + CDC
\c source

CREATE TABLE public."Division" (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE public."Job" (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT,
    "divisionId" INTEGER REFERENCES public."Division"(id),
    "phaseId" INTEGER,
    "contactId" INTEGER,
    "expectedOrderAmount" NUMERIC,
    "invoiceTotalAmount" NUMERIC,
    "showInKanban" BOOLEAN NOT NULL DEFAULT true,
    "finishedAt" TIMESTAMPTZ,
    "cancelledAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public."Job" REPLICA IDENTITY FULL;

CREATE TABLE public."Client" (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    "companyName" TEXT,
    phone TEXT,
    email TEXT,
    "isCompany" BOOLEAN NOT NULL DEFAULT false,
    "isArchive" BOOLEAN NOT NULL DEFAULT false,
    "divisionId" INTEGER REFERENCES public."Division"(id),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public."Client" REPLICA IDENTITY FULL;

ALTER TABLE public."Division" REPLICA IDENTITY FULL;

-- Seed data
INSERT INTO public."Division" (name) VALUES
    ('Engineering'),
    ('Marketing'),
    ('Sales'),
    ('Operations');

INSERT INTO public."Job" (title, slug, "divisionId", "expectedOrderAmount", "showInKanban") VALUES
    ('Office renovation',     'office-renovation',     1, 1500000, true),
    ('HVAC installation',     'hvac-installation',     1, 2800000, true),
    ('Electrical rewiring',   'electrical-rewiring',   1, 950000,  true),
    ('Marketing campaign',    'marketing-campaign',    2, 500000,  true),
    ('Sales training',        'sales-training',        3, 300000,  false),
    ('Warehouse expansion',   'warehouse-expansion',   4, 4200000, true),
    ('Security upgrade',      'security-upgrade',      1, 1200000, true),
    ('Plumbing overhaul',     'plumbing-overhaul',     4, 780000,  true),
    ('Roof repair',           'roof-repair',           1, 650000,  true),
    ('Interior painting',     'interior-painting',     2, 420000,  true);

INSERT INTO public."Client" (name, "companyName", phone, email, "isCompany", "divisionId") VALUES
    ('Tanaka Taro',       'Acme Corp',        '03-1234-5678', 'tanaka@acme.co.jp',      true,  1),
    ('Suzuki Hanako',     NULL,               '090-1111-2222', 'suzuki@example.com',     false, 2),
    ('Sato Construction', 'Sato Construction', '06-9876-5432', 'info@sato-const.co.jp',  true,  1),
    ('Yamada Ichiro',     'Globex Inc',        '03-5555-6666', 'yamada@globex.co.jp',    true,  3),
    ('Takahashi Yuki',    NULL,               '080-3333-4444', 'takahashi@example.com',  false, 4);

-- Create publication and replication slot for Sequin
CREATE PUBLICATION sequin_pub FOR ALL TABLES;
SELECT pg_create_logical_replication_slot('sequin_slot', 'pgoutput');

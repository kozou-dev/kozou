-- Nimart sample schema (v0.1).
-- 美術品 (絵画) 販売管理の最小サンプル。kozou の比較デモ (Kozou v0.1 spec §11.1
-- 「販売可能在庫を作家別に集計する」) を成立させるための最小限の構造を持つ。
--
-- 階層: artists -< artworks -< editions -< inventory_items
-- メタデータ: images (artwork / artist / inventory_item のいずれか 1 つに紐づく)
-- マスタ: code_sets / code_values (nationality, medium, edition_type)
--
-- COMMENT 記法は Kozou v0.1 spec §10.1 に準拠 (@ai / @widget / @policy / @example tag)。
-- 業務概念は §1.2 単独 source 原則に従い、CREATE VIEW + COMMENT ON VIEW で表現する。

-- ========== code masters ==========

CREATE TABLE code_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  label       text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);




CREATE TABLE code_values (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_set_id  uuid NOT NULL REFERENCES code_sets(id),
  code         text NOT NULL,
  label        text NOT NULL,
  description  text,
  sort_order   int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_set_id, code)
);




-- ========== artists ==========

CREATE TABLE artists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text NOT NULL,
  legal_name       text,
  birth_year       int CHECK (birth_year IS NULL OR birth_year BETWEEN 1000 AND 2100),
  death_year       int CHECK (death_year IS NULL OR death_year BETWEEN 1000 AND 2100),
  nationality_code text,
  bio              text,
  homepage_url     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);






-- ========== artworks ==========

CREATE TABLE artworks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id      uuid NOT NULL REFERENCES artists(id),
  title          text NOT NULL,
  alt_title      text,
  year_created   int CHECK (year_created IS NULL OR year_created BETWEEN 1000 AND 2100),
  medium_code    text,
  description    text,
  catalog_number text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);





-- ========== editions ==========

CREATE TABLE editions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artwork_id        uuid NOT NULL REFERENCES artworks(id),
  edition_label     text NOT NULL,
  total_count       int  NOT NULL CHECK (total_count >= 1),
  edition_type_code text NOT NULL,
  catalog_price     numeric(12, 2) CHECK (catalog_price IS NULL OR catalog_price >= 0),
  released_at       date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (artwork_id, edition_label)
);






-- ========== inventory_items ==========
-- Kozou v0.1 spec §10.2.3 の正本。

CREATE TABLE inventory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id    uuid NOT NULL REFERENCES editions(id),
  serial_number int  NOT NULL,
  status        text NOT NULL CHECK (status IN ('for_sale', 'reserved', 'sold')),
  selling_price numeric(12, 2) CHECK (selling_price IS NULL OR selling_price >= 0),
  sold_at       timestamptz,
  reserved_at   timestamptz,
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (edition_id, serial_number)
);







-- ========== images ==========

CREATE TABLE images (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artwork_id        uuid REFERENCES artworks(id),
  artist_id         uuid REFERENCES artists(id),
  inventory_item_id uuid REFERENCES inventory_items(id),
  url               text NOT NULL,
  alt_text          text,
  width             int  CHECK (width  IS NULL OR width  > 0),
  height            int  CHECK (height IS NULL OR height > 0),
  display_order     int  NOT NULL DEFAULT 0,
  is_primary        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (
    (CASE WHEN artwork_id        IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN artist_id         IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN inventory_item_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);




-- ========== seed: code_sets / code_values (デモ用最小データ) ==========

INSERT INTO code_sets (code, label, description) VALUES
  ('nationality', '国籍', '作家の国籍'),
  ('medium', '媒体', '作品の媒体 (絵画手法・素材)'),
  ('edition_type', 'エディション種別', 'editions の type');

INSERT INTO code_values (code_set_id, code, label, sort_order)
SELECT id, 'JP', '日本', 1 FROM code_sets WHERE code = 'nationality'
UNION ALL
SELECT id, 'US', 'アメリカ', 2 FROM code_sets WHERE code = 'nationality'
UNION ALL
SELECT id, 'FR', 'フランス', 3 FROM code_sets WHERE code = 'nationality'
UNION ALL
SELECT id, 'oil_on_canvas', '油彩 (キャンバス)', 1 FROM code_sets WHERE code = 'medium'
UNION ALL
SELECT id, 'lithograph', 'リトグラフ', 2 FROM code_sets WHERE code = 'medium'
UNION ALL
SELECT id, 'screenprint', 'スクリーンプリント', 3 FROM code_sets WHERE code = 'medium'
UNION ALL
SELECT id, 'watercolor', '水彩', 4 FROM code_sets WHERE code = 'medium'
UNION ALL
SELECT id, 'unique', '1 点もの (原画)', 1 FROM code_sets WHERE code = 'edition_type'
UNION ALL
SELECT id, 'print', '版画 (限定刷)', 2 FROM code_sets WHERE code = 'edition_type'
UNION ALL
SELECT id, 'ap', 'AP (artist proof)', 3 FROM code_sets WHERE code = 'edition_type';

-- ========== VIEWs (業務概念) ==========

CREATE VIEW vw_inventory_for_sale AS
  SELECT
    i.id,
    i.edition_id,
    i.serial_number,
    i.selling_price,
    e.artwork_id,
    a.title         AS artwork_title,
    a.artist_id,
    ar.display_name AS artist_name
  FROM inventory_items i
  JOIN editions e ON e.id = i.edition_id  AND e.deleted_at  IS NULL
  JOIN artworks a ON a.id = e.artwork_id  AND a.deleted_at  IS NULL
  JOIN artists  ar ON ar.id = a.artist_id AND ar.deleted_at IS NULL
  WHERE i.status     = 'for_sale'
    AND i.deleted_at IS NULL
    AND i.visibility = 'public';


CREATE VIEW vw_artworks_missing_images AS
  SELECT
    a.id,
    a.title,
    a.artist_id,
    ar.display_name AS artist_name,
    a.created_at
  FROM artworks a
  JOIN artists ar ON ar.id = a.artist_id AND ar.deleted_at IS NULL
  WHERE a.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM images im
      WHERE im.artwork_id = a.id AND im.deleted_at IS NULL
    );


CREATE VIEW vw_artist_inventory_summary AS
  SELECT
    ar.id              AS artist_id,
    ar.display_name    AS artist_name,
    COUNT(DISTINCT a.id) FILTER (WHERE a.deleted_at IS NULL) AS artwork_count,
    COUNT(DISTINCT e.id) FILTER (WHERE e.deleted_at IS NULL) AS edition_count,
    COUNT(i.id) FILTER (
      WHERE i.status     = 'for_sale'
        AND i.deleted_at IS NULL
        AND i.visibility = 'public'
    )                  AS for_sale_count,
    COUNT(i.id) FILTER (
      WHERE i.status     = 'sold'
        AND i.deleted_at IS NULL
    )                  AS sold_count
  FROM artists ar
  LEFT JOIN artworks        a ON a.artist_id = ar.id
  LEFT JOIN editions        e ON e.artwork_id = a.id
  LEFT JOIN inventory_items i ON i.edition_id = e.id
  WHERE ar.deleted_at IS NULL
  GROUP BY ar.id, ar.display_name;


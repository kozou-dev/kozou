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

COMMENT ON TABLE code_sets IS
  'コード値集合のマスタ (例: nationality, medium, edition_type)。
   各 set 配下に複数の code_values を持つ。

   @ai: 業務 enum を VIEW やレポートで使うときの参照元。
        artists.nationality_code 等の text 列は code_values.code への
        logical FK として運用する (実 FK にはしない、code_values.code が
        code_set_id 内 unique のため)。';

COMMENT ON COLUMN code_sets.code IS
  'set 識別子 (機械可読、unique)。例: nationality / medium / edition_type。

   @ai: アプリケーション側ではこの code を key として code_values を SELECT する。';

COMMENT ON COLUMN code_sets.label IS '人間向け表示名 (例: 国籍 / 媒体 / エディション種別)。';

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

COMMENT ON TABLE code_values IS
  '各 code_set 配下の具体的なコード値。

   @ai: artists.nationality_code / artworks.medium_code / editions.edition_type_code
        は code_values.code (該当 set 内) を参照する logical FK。
        値を取り出すには code_set_id でフィルタしてから code で JOIN する。';

COMMENT ON COLUMN code_values.code IS
  '機械可読な値 (例: JP, US / oil_on_canvas, lithograph / print, unique, ap)。';

COMMENT ON COLUMN code_values.label IS '人間向け表示名 (例: 日本, アメリカ / 油彩, リトグラフ)。';

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

COMMENT ON TABLE artists IS
  '作家マスタ。1 作家が複数の作品 (artworks) を持つ。

   @ai: display_name は公開向け表示名、legal_name は内部記録 (戸籍上の名等)。
        没年が未設定 (death_year IS NULL) の作家は存命と見なす。
        deleted_at IS NOT NULL のレコードは全 query から除外する。';

COMMENT ON COLUMN artists.display_name IS
  '公開向け表示名。UI 一覧と外部 API で使う。';

COMMENT ON COLUMN artists.legal_name IS
  '戸籍上の名前など、内部記録用。公開しない。

   @policy: 顧客対応・契約書類でのみ参照。';

COMMENT ON COLUMN artists.nationality_code IS
  '国籍 (code_values.code、code_sets.code = ''nationality''の値)。

   @widget: enum-select
   @ai: code_values で code_set = nationality の集合を引いて選択肢を作る。';

COMMENT ON COLUMN artists.deleted_at IS
  'soft delete 用。NULL でない場合は論理削除済み。

   @ai: アクティブ判定には deleted_at IS NULL を必ず付ける。';

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

COMMENT ON TABLE artworks IS
  '作品マスタ (オリジナル単位)。1 作品 = 1 オリジナル概念。
   実物販売単位 (個体) は inventory_items、版画の限定刷数は editions 経由で表現する。

   @ai: 原画 1 点ものは editions を 1 件だけ作って total_count=1。
        版画は editions に 1st edition / AP などを別レコードで持つ。
        作品一覧の表示には title + artists.display_name の JOIN を推奨。';

COMMENT ON COLUMN artworks.title IS
  '作品名。';

COMMENT ON COLUMN artworks.medium_code IS
  '媒体 (code_values.code、code_sets.code = ''medium''の値)。例: oil_on_canvas, lithograph。

   @widget: enum-select
   @ai: 媒体別の集計や検索に使う。null 許容 (不明な作品)。';

COMMENT ON COLUMN artworks.catalog_number IS
  '公式カタログ番号 (unique)。Catalogue raisonné における識別子。

   @policy: 一度割り振った番号は変更しない。空欄可。';

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

COMMENT ON TABLE editions IS
  'エディション。1 つの artwork から複数の edition を切り出す (版画の限定刷数表現)。
   原画 1 点ものは total_count=1 の単一 edition として表す。

   @ai: 1 edition の中で個別販売単位 (inventory_items) を total_count 個まで作る。
        UI で「在庫数」は inventory_items を COUNT する、editions.total_count は capacity。';

COMMENT ON COLUMN editions.edition_label IS
  'エディション名 (例: 1st edition, AP, original)。同一 artwork 内でユニーク。

   @policy: 一度確定したら原則変更しない (カタログ整合性のため)。';

COMMENT ON COLUMN editions.total_count IS
  '刷数上限。inventory_items の作成上限として運用。

   @widget: number
   @ai: total_count を超える inventory_items 作成は UI レベルでブロックすること
        (現状 DB 制約はない、Step 3 以降で trigger 検討)。';

COMMENT ON COLUMN editions.edition_type_code IS
  'エディション種別 (code_values.code、code_sets.code = ''edition_type''の値)。
   例: print (版画), unique (1 点もの), ap (artist proof)。

   @widget: enum-select';

COMMENT ON COLUMN editions.catalog_price IS
  '正規価格 (税抜、JPY)。

   @widget: currency
   @policy: 実際の販売価格は inventory_items.selling_price で個別管理。
            catalog_price はリスト価格 (参考)。';

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

COMMENT ON TABLE inventory_items IS
  '在庫個体。エディション作品の個別販売単位を表す。
   1 つの edition は複数の inventory_items を持つ (serial_number ごと)。

   @ai: 販売可能在庫の抽出には vw_inventory_for_sale を優先利用すること。
        deleted_at IS NOT NULL のレコードは全 query から除外すること。';

COMMENT ON COLUMN inventory_items.serial_number IS
  '同一 edition 内の通し番号 (1 始まり)。edition_label と組み合わせて "23/50" のように表示する。

   @widget: number
   @policy: 1 始まり、edition.total_count を超えない (運用ルール)。';

COMMENT ON COLUMN inventory_items.status IS
  '在庫状態。
   for_sale: 販売可能
   reserved: 予約中
   sold:     販売済み

   @widget: enum-select';

COMMENT ON COLUMN inventory_items.selling_price IS
  '実販売価格 (税抜、JPY)。catalog_price からのディスカウントや個別交渉価格を反映。

   @widget: currency';

COMMENT ON COLUMN inventory_items.visibility IS
  '公開可視性。
   public:  公開 (vw_inventory_for_sale に含まれる、外部 API 公開対象)
   private: 非公開 (内部閲覧のみ)

   @widget: enum-select
   @policy: 委託前 / 検品中 / 顧客との交渉中などは private に。';

COMMENT ON COLUMN inventory_items.deleted_at IS
  'soft delete 用。NULL でない場合は論理削除済みとして扱う。

   @ai: アクティブ判定には deleted_at IS NULL を必ず付ける。';

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

COMMENT ON TABLE images IS
  '画像メタデータ。本体は外部ストレージ (S3 / CDN など) に置く前提で、url のみ管理する。
   1 レコードは artwork / artist / inventory_item のいずれか 1 つだけに紐づく (排他)。

   @ai: 画像が必要な作品の検出は vw_artworks_missing_images を参照。
        kozou v0.1 ではアップロード処理は実装しない (URL の表示のみ)。';

COMMENT ON COLUMN images.url IS
  '画像 URL (外部 S3 / CDN を想定)。

   @widget: image-url
   @policy: kozou が画像本体をホストしない。url の到達性は呼び出し側の責任。';

COMMENT ON COLUMN images.is_primary IS
  '代表画像フラグ。同一エンティティ内で複数 true でも DB は許容するが、UI 表示では先頭 1 件のみ採用する。

   @widget: boolean';

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

COMMENT ON VIEW vw_inventory_for_sale IS
  '販売可能在庫の一覧。
   soft delete された個体、非公開個体、予約中・販売済み個体、削除された
   親レコード (edition / artwork / artist) は除外される。
   作品情報と作家情報も結合済みで、UI 一覧表示や外部 API 公開に直接利用可。

   @ai: 「販売可能」「在庫表示」「カタログ用」を扱う場合はこの VIEW を起点に使う。
        artists / artworks / editions を再 JOIN する必要はない。
   @example: 作家別の販売可能在庫数
     SELECT artist_name, COUNT(*) AS for_sale_count
     FROM vw_inventory_for_sale
     GROUP BY artist_name
     ORDER BY for_sale_count DESC;';

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

COMMENT ON VIEW vw_artworks_missing_images IS
  '画像未登録の作品一覧。
   artworks のうち、関連 images が 0 件 (または soft delete のみ) のもの。

   @ai: 「画像登録待ち」「カタログ作成タスク」を扱う場合の起点。
        作家別画像未登録数の集計にも使える。';

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

COMMENT ON VIEW vw_artist_inventory_summary IS
  '作家別の在庫サマリ。
   - artwork_count: アクティブな作品数
   - edition_count: アクティブな edition 数
   - for_sale_count: 販売可能 (public + active) な個体数
   - sold_count: 販売済み (active) な個体数

   @ai: dashboard / 作家別 KPI / 比較デモの「販売可能在庫を作家別に集計」に直接使える。
        この VIEW で 1 query 完結する設計のため、tables を個別 JOIN する SQL を AI が
        生成した場合は VIEW 利用案を推奨すること。
   @example:
     SELECT artist_name, for_sale_count
     FROM vw_artist_inventory_summary
     WHERE for_sale_count > 0
     ORDER BY for_sale_count DESC;';

-- Stänger demo-läget: tar bort alla publika RLS-policyer som lät
-- oautentiserade besökare läsa/skriva demo-brandens data.

drop policy if exists "demo_read_brands" on brands;
drop policy if exists "demo_write_brands" on brands;

drop policy if exists "demo_read_customers" on customers;
drop policy if exists "demo_write_customers" on customers;

drop policy if exists "demo_read_orders" on orders;

drop policy if exists "demo_read_products" on products;

drop policy if exists "demo_read_sales_reps" on sales_reps;

drop policy if exists "demo_read_segments" on segments;
drop policy if exists "demo_segments_select" on segments;
drop policy if exists "demo_segments_insert" on segments;
drop policy if exists "demo_segments_update" on segments;
drop policy if exists "demo_segments_delete" on segments;

drop policy if exists "demo_read_segment_memberships" on segment_memberships;
drop policy if exists "demo_memberships_select" on segment_memberships;
drop policy if exists "demo_memberships_insert" on segment_memberships;
drop policy if exists "demo_memberships_delete" on segment_memberships;

drop policy if exists "demo_read_web_sessions" on web_sessions;

-- 0018: Backend Session Binding removed. Oma no longer keeps
-- cross-Run SQLite sessions; every Agent Run rebuilds from the full Product
-- Context projection. The table is Product-owned residue of the deleted
-- session continuity path - drop it (no compatibility code).
DROP TABLE `backend_session_binding`;

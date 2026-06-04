/* ============================================
   QOAN — Configuration & Supabase Init
   ============================================ */

const SUPABASE_URL = 'https://bxuapccwvihylqbbpvjh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ninl1RmTmfZrQsX8MI-tmw_UhtZuUiX';
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1509721434505609297/CnpP_HBJszZ8xnVlJyIWLO6Hd_vEAwJPC5wRfNrAWATzwZ25e9ALrTi-GI5O_gb_97TD?thread_id=1509720959844745317';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

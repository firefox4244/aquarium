/**
 * Публичная конфигурация приложения Aquarium.
 *
 * ВАЖНО:
 * - Здесь допустимо хранить только ПУБЛИЧНЫЕ параметры Supabase.
 * - `anon key` предназначен для использования в браузере.
 * - `service_role` key сюда помещать НИКОГДА нельзя —
 *   он даёт полный доступ к базе в обход RLS.
 */
window.AQUARIUM_CONFIG = {
  /** URL проекта Supabase, например: https://xxxx.supabase.co */
  SUPABASE_URL: 'https://bxqlprukyffxmghhyerx.supabase.co',

  /** Публичный anon-ключ Supabase (безопасен для браузера). */
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4cWxwcnVreWZmeG1naGh5ZXJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MTM3MzksImV4cCI6MjEwNzQ4OTczOX0.hZzBcrcW7_MjFR5QHJGYOVOIHU4LZwPilPvq085PU2U',
};
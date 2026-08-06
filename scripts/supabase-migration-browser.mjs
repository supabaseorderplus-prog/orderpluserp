#!/usr/bin/env node
/**
 * Open Supabase SQL Editor in your Chrome and copy migration SQL to clipboard
 * Uses your actual Chrome - so you're already logged in to Supabase
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL = readFileSync(join(__dirname, '../supabase-migrations/RUN-THIS-ONCE-product-categories.sql'), 'utf8')
const SQL_EDITOR_URL = 'https://supabase.com/dashboard/project/slgrxczjnburhggnmaew/sql/new'

// Copy SQL to clipboard
const tmpSql = join(process.env.TMPDIR || '/tmp', 'supabase-migration.sql')
writeFileSync(tmpSql, SQL)
execSync(`cat "${tmpSql}" | pbcopy`)

// Open in user's Chrome (uses their session - already logged in)
execSync(`open -a "Google Chrome" "${SQL_EDITOR_URL}"`)

console.log('✓ Opened Supabase SQL Editor in Chrome')
console.log('✓ Migration SQL copied to clipboard')
console.log('\n→ Paste (Cmd+V) in the editor and click Run\n')

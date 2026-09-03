import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** defaultEnchants из oluh-bot catalog.json (crusher_*).
 *  Боты крушителя на FunTime часто feather_falling 4, не 5 — в json стоит 4.
 */
export const CRUSHER_KITS = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'funtime-crusher-kits.json'), 'utf8'),
);

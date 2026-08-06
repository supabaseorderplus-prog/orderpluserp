"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabaseAdmin = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY - credit analysis may not work');
}
let _admin = null;
function getAdmin() {
    if (!_admin) {
        if (!supabaseUrl || !supabaseServiceKey) {
            throw new Error('Supabase configuration missing');
        }
        _admin = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey);
    }
    return _admin;
}
exports.supabaseAdmin = new Proxy({}, {
    get(_target, prop) {
        const client = getAdmin();
        const val = client[prop];
        if (typeof val === 'function')
            return val.bind(client);
        return val;
    },
});
//# sourceMappingURL=supabase.js.map
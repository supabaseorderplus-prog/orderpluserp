export const SCHEME_PARTY_TYPES = ['COMPANY', 'CNF', 'SUPER_DEALER', 'RETAILER', 'SALESMAN', 'MANUFACTURER', 'ALL', 'INDIVIDUAL'] as const
export type SchemePartyType = (typeof SCHEME_PARTY_TYPES)[number]

export type SchemeScopeMode = 'GROUP' | 'INDIVIDUAL'

const SCHEME_SCOPE_META_KEY = '__hometech_scheme_scope'

type SchemeScopeMetaPayload = {
  [SCHEME_SCOPE_META_KEY]?: {
    mode?: unknown
    applicable_party_type?: unknown
    individual_party_type?: unknown
    party_names?: unknown
  }
  terms_conditions?: unknown
}

export type SchemeScopeInfo = {
  mode: SchemeScopeMode
  applicablePartyType: SchemePartyType
  individualPartyType: SchemePartyType | null
  termsConditions: string | null
  hasStoredScope: boolean
  partyNames: string[]
}

export function normalizeSchemePartyType(value: unknown): SchemePartyType | null {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')

  return SCHEME_PARTY_TYPES.includes(normalized as SchemePartyType)
    ? (normalized as SchemePartyType)
    : null
}

export function getSchemePartyTypesForUser(params: {
  role?: unknown
  partyTypeName?: unknown
}): SchemePartyType[] {
  const roleName = String(params.role || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')

  const roleAliases: Record<string, SchemePartyType> = {
    CNF_USER: 'CNF',
    COMPANY_USER: 'COMPANY',
    RETAILER_USER: 'RETAILER',
    SALESMAN_USER: 'SALESMAN',
    SUPER_DEALER_USER: 'SUPER_DEALER',
    MANUFACTURER_USER: 'MANUFACTURER',
  }

  const roleType =
    normalizeSchemePartyType(roleAliases[roleName] || roleName) ||
    (roleName.endsWith('_USER') ? normalizeSchemePartyType(roleName.replace(/_USER$/, '')) : null)

  if (roleType) return [roleType]

  const partyType = normalizeSchemePartyType(params.partyTypeName)
  return partyType ? [partyType] : []
}

export function parseSchemeScopeMeta(rawTerms: unknown, fallbackPartyType: unknown): SchemeScopeInfo {
  const fallbackType = normalizeSchemePartyType(fallbackPartyType) || 'ALL'
  const fallbackMode: SchemeScopeMode = fallbackType === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'GROUP'
  const fallbackTerms = typeof rawTerms === 'string' ? rawTerms : null

  if (!rawTerms || typeof rawTerms !== 'string') {
    return {
      mode: fallbackMode,
      applicablePartyType: fallbackType,
      individualPartyType: null,
      termsConditions: fallbackTerms,
      hasStoredScope: false,
      partyNames: [],
    }
  }

  try {
    const parsed = JSON.parse(rawTerms) as SchemeScopeMetaPayload
    const storedScope = parsed && typeof parsed === 'object' ? parsed[SCHEME_SCOPE_META_KEY] : null

    if (!storedScope || typeof storedScope !== 'object') {
      return {
        mode: fallbackMode,
        applicablePartyType: fallbackType,
        individualPartyType: null,
        termsConditions: fallbackTerms,
        hasStoredScope: false,
        partyNames: [],
      }
    }

    const mode: SchemeScopeMode = storedScope.mode === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'GROUP'
    const applicablePartyType = normalizeSchemePartyType(storedScope.applicable_party_type) || fallbackType
    const individualPartyType = normalizeSchemePartyType(storedScope.individual_party_type)
    const termsConditions = typeof parsed.terms_conditions === 'string' && parsed.terms_conditions.trim()
      ? parsed.terms_conditions
      : null
    const partyNames = Array.isArray(storedScope.party_names)
      ? (storedScope.party_names as unknown[]).filter((n): n is string => typeof n === 'string')
      : []

    return {
      mode,
      applicablePartyType,
      individualPartyType,
      termsConditions,
      hasStoredScope: true,
      partyNames,
    }
  } catch {
    return {
      mode: fallbackMode,
      applicablePartyType: fallbackType,
      individualPartyType: null,
      termsConditions: fallbackTerms,
      hasStoredScope: false,
      partyNames: [],
    }
  }
}

export function encodeSchemeScopeTerms(params: {
  termsConditions: unknown
  mode: SchemeScopeMode
  applicablePartyType: SchemePartyType
  individualPartyType?: SchemePartyType | null
  partyNames?: string[]
}): string {
  return JSON.stringify({
    [SCHEME_SCOPE_META_KEY]: {
      mode: params.mode,
      applicable_party_type: params.applicablePartyType,
      individual_party_type: params.individualPartyType || null,
      party_names: params.partyNames ?? [],
    },
    terms_conditions: typeof params.termsConditions === 'string' ? params.termsConditions : '',
  })
}

export function mapSchemeScopeForResponse<T extends { applicable_party_type?: string | null; terms_conditions?: string | null }>(
  row: T,
): T & { enrolled_party_names?: string[]; individual_party_type?: SchemePartyType | null } {
  const scope = parseSchemeScopeMeta(row.terms_conditions, row.applicable_party_type)
  if (!scope.hasStoredScope) return row

  return {
    ...row,
    applicable_party_type: scope.mode === 'INDIVIDUAL' ? 'INDIVIDUAL' : scope.applicablePartyType,
    terms_conditions: scope.termsConditions,
    individual_party_type: scope.individualPartyType,
    ...(scope.mode === 'INDIVIDUAL' && scope.partyNames.length > 0
      ? { enrolled_party_names: scope.partyNames }
      : {}),
  }
}

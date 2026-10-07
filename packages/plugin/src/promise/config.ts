/**
 * The host config seam for promise plugins. Only reloading is exposed:
 * reading or editing config documents stays with the host.
 */
export interface ConfigDomain {
  readonly reload: (options?: { readonly force?: boolean }) => Promise<void>
}

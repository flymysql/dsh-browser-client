/**
 * store.js — durable WorkflowDefinition store backed by ctx.storageDomain.
 *
 * Saves workflow definitions as validated records in a `workflows` domain
 * table, keyed by workflow id. Cross-session, zod-validated at the durable
 * boundary (storage-domain uses zod ^4 for its DomainSpec valueSchema).
 *
 * Usage (host side, inside the plugin):
 *   const store = await openWorkflowStore(ctx)
 *   await store.save(def)            // assigns id on create
 *   const all = store.list()
 *   const one = store.get(id)
 *   await store.remove(id)
 *   store.close()                    // plugin teardown
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { randomUUID } from 'node:crypto'

/** Zod schema for a stored workflow record (validated at the durable boundary). */
export const WorkflowRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number(),
  trigger: z.object({
    kind: z.union([z.literal('manual'), z.literal('schedule')]).default('manual'),
    schedule: z.object({
      everySeconds: z.number().optional(),
      at: z.string().optional(),
      timeZone: z.string().optional()
    }).optional()
  }).default({ kind: 'manual' }),
  target: z.object({
    urlPattern: z.string().default('*'),
    titlePattern: z.string().optional()
  }).default({ urlPattern: '*' }),
  steps: z.array(z.unknown()).default([]),
  parameters: z.array(z.unknown()).default([]),
  approval: z.object({
    confirmOn: z.array(z.union([z.literal('write'), z.literal('batch'), z.literal('navigate-external')])).default(['write', 'batch']),
    sampleBeforeBatch: z.boolean().default(true)
  }).default({ confirmOn: ['write', 'batch'], sampleBeforeBatch: true }),
  verify: z.object({
    successCriteria: z.array(z.string()).default([]),
    retry: z.object({
      maxAttempts: z.number().default(1),
      onFailure: z.union([z.literal('ask-user'), z.literal('skip'), z.literal('stop')]).default('ask-user')
    }).default({ successCriteria: [], retry: { maxAttempts: 1, onFailure: 'ask-user' } })
  }).default({ successCriteria: [], retry: { maxAttempts: 1, onFailure: 'ask-user' } }),
  output: z.object({
    saveScreenshots: z.boolean().default(false),
    collectTo: z.union([z.literal('workspace'), z.literal('sheet'), z.literal('copy')]).default('workspace')
  }).default({ saveScreenshots: false, collectTo: 'workspace' })
})

/** Declare the workflows domain (name + version + table). */
export const workflowsDomainSpec = defineDomain({
  name: 'dsh_browser_workflows',
  version: 1,
  tables: {
    workflows: domainTable(WorkflowRecordSchema)
  }
})

/**
 * Open the workflow store. Caller owns close() (typically ctx.effect disposer).
 * @param {import('@deepseek-ai/cordis').Context} ctx - context with storageDomain.
 * @returns {Promise<WorkflowStore>}
 */
export async function openWorkflowStore(ctx) {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined) {
    throw new Error('storageDomain service not available — cannot persist workflows')
  }
  const domain = await storageDomain.open(workflowsDomainSpec)
  const table = domain.table('workflows')

  const assertRecord = (rec) => {
    const parsed = WorkflowRecordSchema.safeParse(rec)
    if (!parsed.success) throw new Error(`corrupt workflow record: ${parsed.error.message}`)
    return parsed.data
  }

  const store = {
    list() {
      const out = []
      for (const [, v] of table.entries()) out.push(assertRecord(v))
      out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return out
    },

    get(id) {
      const v = table.get(id)
      return v ? assertRecord(v) : undefined
    },

    async save(def) {
      const now = Date.now()
      const existing = def.id ? table.get(def.id) : undefined
      const record = {
        ...(existing || {}),
        ...def,
        id: def.id || randomUUID(),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        version: existing ? (existing.version || 0) + 1 : 1
      }
      assertRecord(record)
      await table.put(record.id, record)
      return assertRecord(table.get(record.id))
    },

    async remove(id) {
      return table.delete(id)
    },

    get size() {
      return table.size
    },

    close() {
      return domain.close()
    }
  }
  return store
}

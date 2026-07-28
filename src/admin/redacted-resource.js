import { Resource as SqlResource } from '@adminjs/sql'

// AdminJS's `isVisible: false` is a UI flag only — BaseRecord.toJSON serialises
// `params` verbatim, so a "hidden" column still ships to the browser in every
// list/show payload. Redaction has to happen at the query, so the column never
// leaves Postgres, and on writes, so it can never be set through the panel.
export class RedactedSqlResource extends SqlResource {
  constructor(info, hiddenColumns = []) {
    super(info)
    this.hiddenColumns = new Set(hiddenColumns)
    this.visibleColumns = info.properties
      .map((property) => property.path())
      .filter((path) => !this.hiddenColumns.has(path))
  }

  properties() {
    return super.properties().filter((property) => !this.hiddenColumns.has(property.path()))
  }

  property(path) {
    return this.hiddenColumns.has(path) ? null : super.property(path)
  }

  withoutHidden(params) {
    return Object.fromEntries(
      Object.entries(params ?? {}).filter(([key]) => !this.hiddenColumns.has(key))
    )
  }

  tableQuery() {
    return this.schemaName
      ? this.knex(this.tableName).withSchema(this.schemaName)
      : this.knex(this.tableName)
  }

  // Mirrors SqlResource.find, but selects only the visible columns. count() is
  // deliberately left alone — narrowing the select there would turn its
  // aggregate into an invalid non-grouped query.
  async find(filter, options = {}) {
    const query = this.filterQuery(filter).select(this.visibleColumns)
    if (options.limit) {
      query.limit(options.limit)
    }
    if (options.offset) {
      query.offset(options.offset)
    }
    if (options.sort?.sortBy) {
      query.orderBy(options.sort.sortBy, options.sort.direction)
    }
    const rows = await query
    return rows.map((row) => this.build(row))
  }

  async findOne(id) {
    const rows = await this.tableQuery().where(this.idColumn, id).select(this.visibleColumns)
    return rows[0] ? this.build(rows[0]) : null
  }

  async findMany(ids) {
    const rows = await this.tableQuery().whereIn(this.idColumn, ids).select(this.visibleColumns)
    return rows.map((row) => this.build(row))
  }

  async create(params) {
    return super.create(this.withoutHidden(params))
  }

  async update(id, params) {
    const row = await super.update(id, this.withoutHidden(params))
    return this.withoutHidden(row)
  }
}

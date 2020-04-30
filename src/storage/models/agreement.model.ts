import { Table, Column, Model, ForeignKey, BelongsTo, DataType } from 'sequelize-typescript'
import Offer from './offer.model'

@Table({
  freezeTableName: true,
  tableName: 'storage_agreement'
})
export default class Agreement extends Model {
  @Column({ type: DataType.STRING(67), primaryKey: true })
  agreementReference!: string

  @Column({ type: DataType.STRING() })
  dataReference!: string

  @Column({ type: DataType.STRING(64) })
  consumer!: string

  @Column
  size!: number

  @Column({ defaultValue: true })
  isActive!: boolean

  @Column
  billingPeriod!: number

  @Column
  billingPrice!: number

  @Column
  availableFunds!: number

  @ForeignKey(() => Offer)
  @Column
  offerId!: string

  @BelongsTo(() => Offer)
  offer!: Offer
}

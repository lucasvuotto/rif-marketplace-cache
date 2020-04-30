import Offer from '../models/offer.model'
import BillingPlan from '../models/price.model'
import { EventData } from 'web3-eth-contract'
import { loggingFactory } from '../../logger'
import { Handler } from '../../definitions'

const logger = loggingFactory('storage:handler:offer')

function updatePrices (offer: Offer, period: number, price: number): Promise<BillingPlan> {
  const priceEntity = offer.plans && offer.plans.find(value => value.period === period)
  logger.info(`Updating period ${period} to price ${price} (ID: ${offer.address})`)

  if (priceEntity) {
    priceEntity.amount = price
    return priceEntity.save()
  } else {
    const newPriceEntity = new BillingPlan({ period, amount: price, offerId: offer.address })
    return newPriceEntity.save()
  }
}

const handler: Handler = {
  events: ['CapacitySet', 'MaximumDurationSet', 'PriceSet'],
  async handler (event: EventData): Promise<void> {
    const storer = event.returnValues.storer

    // TODO: Ignored until https://github.com/sequelize/sequelize/pull/11924
    // @ts-ignore
    const [offer, created] = await Offer.findOrCreate({ where: { address: storer }, include: [BillingPlan] })

    if (created) {
      logger.info(`Created new StorageOffer for ${storer}`)
    }

    switch (event.event) {
      case 'CapacitySet':
        offer.totalCapacity = event.returnValues.capacity
        logger.info(`Updating capacity ${offer.totalCapacity} (ID: ${offer.address})`)
        break
      case 'MaximumDurationSet':
        offer.availableFunds = event.returnValues.maximumDuration
        logger.info(`Updating maximum duration ${offer.availableFunds} (ID: ${offer.address})`)
        break
      case 'PriceSet':
        await updatePrices(offer, event.returnValues.period, event.returnValues.price)
        break
      default:
        logger.error(`Unknown event ${event.event}`)
    }

    await offer.save()
  }
}

export default handler

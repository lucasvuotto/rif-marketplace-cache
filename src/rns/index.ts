import simplePlacementsContractAbi from '@rsksmart/rif-marketplace-nfts/ERC721SimplePlacementsABI.json'
import auctionRegistrarContractAbi from '@rsksmart/rns-auction-registrar/TokenRegistrarData.json'
import rnsReverseContractAbi from '@rsksmart/rns-reverse/NameResolverData.json'
import rnsContractAbi from '@rsksmart/rns-rskregistrar/RSKOwnerData.json'
import config from 'config'
import { Service } from 'feathers-sequelize'
import { getObject } from 'sequelize-store'
import { EventData } from 'web3-eth-contract'
import { AbiItem } from 'web3-utils'
import { ethFactory } from '../blockchain'
import { getEventsEmitterForService, isServiceInitialized } from '../blockchain/utils'
import { Application, CachedService } from '../definitions'
import { loggingFactory } from '../logger'
import { errorHandler, waitForReadyApp } from '../utils'
import domainOfferHooks from './hooks/domain-offer.hooks'
import domainHooks from './hooks/domain.hooks'
import soldDomainHooks from './hooks/sold-domain.hooks'
import DomainOffer from './models/domain-offer.model'
import Domain from './models/domain.model'
import SoldDomain from './models/sold-domain.model'
import Transfer from './models/transfer.model'
import { processAuctionRegistrar, processRskOwner } from './rns.precache'
import eventProcessor from './rns.processor'
import { Eth } from 'web3-eth'
import rnsChannels from './rns.channels';

const logger = loggingFactory('rns')

export class RnsService extends Service {
}
export interface RnsServices {
  domains: RnsService
  sold: RnsService
  offers: RnsService
}

function fetchEventsForService(eth: Eth, serviceName: string, abi: AbiItem[], dataPusher: (event: EventData) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const eventsEmitter = getEventsEmitterForService(serviceName, eth, abi)
    eventsEmitter.on('initFinished', () => {
      eventsEmitter.off('newEvent', dataPusher)
      resolve()
    })
    eventsEmitter.on('newEvent', dataPusher)
    eventsEmitter.on('error', (e: Error) => {
      logger.error(`There was unknown error in Events Emitter! ${e}`)
      reject(e)
    })
  })
}

async function precache(eth?: Eth): Promise<void> {
  eth = eth || ethFactory()
  const precacheLogger = loggingFactory('rns:precache:processor')
  const eventsDataQueue: EventData[] = []
  const dataQueuePusher = (event: EventData): void => { eventsDataQueue.push(event) }

  await processAuctionRegistrar(eth, precacheLogger, auctionRegistrarContractAbi.abi as AbiItem[])
  await processRskOwner(eth, precacheLogger, rnsContractAbi.abi as AbiItem[])

  await fetchEventsForService(eth, 'rns.owner', rnsContractAbi.abi as AbiItem[], dataQueuePusher)
  await fetchEventsForService(eth, 'rns.reverse', rnsReverseContractAbi.abi as AbiItem[], dataQueuePusher)
  await fetchEventsForService(eth, 'rns.placement', simplePlacementsContractAbi as AbiItem[], dataQueuePusher)

  // We need to sort the events in order to have valid
  eventsDataQueue.sort((a, b): number => {
    // First by block number
    if (a.blockNumber - b.blockNumber !== 0) return a.blockNumber - b.blockNumber

    if (a.transactionIndex - b.transactionIndex !== 0) return a.transactionIndex - b.transactionIndex

    return a.logIndex - b.logIndex
  })

  const sequelizeServices = {
    domains: new RnsService({ Model: Domain }),
    sold: new RnsService({ Model: SoldDomain }),
    offers: new RnsService({ Model: DomainOffer, multi: true })
  }

  for (const event of eventsDataQueue) {
    await eventProcessor(precacheLogger, eth, sequelizeServices)(event)
  }
}

const rns: CachedService = {
  // eslint-disable-next-line require-await
  async initialize(app: Application): Promise<void> {
    if (!config.get<boolean>('rns.enabled')) {
      logger.info('RNS service: disabled')
      return Promise.resolve()
    }
    logger.info('RNS service: enabled')

    await waitForReadyApp(app)

    // Initialize feather's service
    app.use('/rns/v0/:ownerAddress/domains', new RnsService({ Model: Domain }))
    app.use('/rns/v0/:ownerAddress/sold', new RnsService({ Model: SoldDomain }))
    app.use('/rns/v0/offers', new RnsService({ Model: DomainOffer }))

    const domains = app.service('/rns/v0/:ownerAddress/domains')
    const sold = app.service('/rns/v0/:ownerAddress/sold')
    const offers = app.service('/rns/v0/offers')

    domains.hooks(domainHooks)
    sold.hooks(soldDomainHooks)
    offers.hooks(domainOfferHooks)

    app.configure(rnsChannels);

    // Initialize blockchain watcher
    const eth = app.get('eth') as Eth

    if (!isServiceInitialized('rns.owner')) {
      // TODO: Debug this https://github.com/rsksmart/rif-marketplace-cache/issues/103
      // eslint-disable-next-line no-console
      console.error('Currently the precache on start is not supported! Run precache command before starting the server!')
      process.exit(1)

      // logger.info('Precaching RNS service')
      // try {
      //   await precache(eth)
      //   logger.info('Precaching RNS finished service')
      // } catch (e) {
      //   logger.error(`There was an error while precaching for RNS service! ${e}`)
      // }
    }
    const services = { domains, sold, offers }
    const rnsEventsEmitter = getEventsEmitterForService('rns.owner', eth, rnsContractAbi.abi as AbiItem[])
    rnsEventsEmitter.on('newEvent', errorHandler(eventProcessor(loggingFactory('rns.owner:processor'), eth, services), logger))
    rnsEventsEmitter.on('error', (e: Error) => {
      logger.error(`There was unknown error in Events Emitter for rns.owner! ${e}`)
    })

    const rnsReverseEventsEmitter = getEventsEmitterForService('rns.reverse', eth, rnsReverseContractAbi.abi as AbiItem[])
    rnsReverseEventsEmitter.on('newEvent', errorHandler(eventProcessor(loggingFactory('rns.reverse:processor'), eth, services), logger))
    rnsReverseEventsEmitter.on('error', (e: Error) => {
      logger.error(`There was unknown error in Events Emitter for rns.reverse! ${e}`)
    })

    const rnsPlacementsEventsEmitter = getEventsEmitterForService('rns.placement', eth, simplePlacementsContractAbi as AbiItem[])
    rnsPlacementsEventsEmitter.on('newEvent', errorHandler(eventProcessor(loggingFactory('rns.placement:processor'), eth, services), logger))
    rnsPlacementsEventsEmitter.on('error', (e: Error) => {
      logger.error(`There was unknown error in Events Emitter for rns.placement! ${e}`)
    })

    return Promise.resolve()
  },

  precache,

  async purge(): Promise<void> {
    const transferCount = await Transfer.destroy({ where: {}, truncate: true, cascade: true })
    const offersCount = await DomainOffer.destroy({ where: {}, truncate: true, cascade: true })
    const soldCount = await SoldDomain.destroy({ where: {}, truncate: true, cascade: true })
    const domainsCount = await Domain.destroy({ where: {}, truncate: true, cascade: true })
    logger.info(`Removed ${offersCount} offers entries, ${soldCount} sold domains, ${transferCount} transfers and ${domainsCount} domains`)

    const store = getObject()
    delete store['rns.placement.lastProcessedBlock']
    delete store['rns.reverse.lastProcessedBlock']
    delete store['rns.owner.lastProcessedBlock']
  }

}

export default rns

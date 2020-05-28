import { Eth } from 'web3-eth'
import { EventData } from 'web3-eth-contract'
import Utils from 'web3-utils'
import { RnsServices } from '.'
import { getBlockDate } from '../blockchain/utils'
import { Logger } from '../definitions'
import DomainOffer from './models/domain-offer.model'
import Domain from './models/domain.model'
import Transfer from './models/transfer.model'

async function transferHandler(logger: Logger, eventData: EventData, _: Eth, services: RnsServices): Promise<void> {
  // Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
  const domainsService = services.domains

  const tokenId = Utils.numberToHex(eventData.returnValues.tokenId)
  const ownerAddress = eventData.returnValues.to.toLowerCase()
  const domain = await Domain.findByPk(tokenId)

  if (eventData.returnValues.from !== '0x0000000000000000000000000000000000000000') {
    // if not exist then create (1 insert), Domain.findCreateFind
    // else create a SoldDomain and update with the new owner the registry (1 insert + update)
    if (!domain) {
      logger.info(`Transfer event: Domain ${tokenId} created`)
      const domain = await domainsService.create({ tokenId, ownerAddress })
      logger.error('rns.processor.ts -> transferHandler -> domain created:', domain)
    } else {
      logger.info(`Transfer event: Domain ${tokenId} updated`)
      const transactionHash = eventData.transactionHash
      const from = eventData.returnValues.from.toLowerCase()

      const transferDomain = await Transfer.create({
        id: transactionHash,
        tokenId,
        sellerAddress: from,
        newOwnerAddress: ownerAddress
      })

      if (transferDomain) {
        logger.info(`Transfer event: Transfer ${tokenId} created`)
      }
      const [affectedRows] = await domainsService.patch(null, { ownerAddress }, { where: { tokenId } })
      console.log('rns.processor.ts -> transferHandler -> affectedRows', affectedRows)

      if (affectedRows) {
        logger.info(`Transfer event: Updated Domain ${domain.name} -> ${tokenId}`)
      } else {
        logger.info(`Transfer event: no Domain ${domain.name} updated`)
      }
    }
  } else if (!domain?.ownerAddress) {
    await domainsService.patch(tokenId, { ownerAddress })
    logger.info(`Transfer event: ${tokenId} ownership updated`)
  }
}

async function expirationChangedHandler(logger: Logger, eventData: EventData, _: Eth, services: RnsServices): Promise<void> {
  // event ExpirationChanged(uint256 tokenId, uint expirationTime);

  const domainsService = services.domains

  const tokenId = Utils.numberToHex(eventData.returnValues.tokenId)
  let normalizedTimestamp = eventData.returnValues.expirationTime as string

  // For the old RNS register where timestamps start with 10000
  if (normalizedTimestamp.startsWith('10000')) {
    normalizedTimestamp = eventData.returnValues.expirationTime.slice(5)
  }
  const expirationDate = parseInt(normalizedTimestamp) * 1000
  const domain = await Domain.findByPk(tokenId)
  console.log('rns.processor.ts -> expirationChangedHandler -> domain:', domain)
  if (domain) {
    await domainsService.update(domain.tokenId, { tokenId, expirationDate })
  } else {
    await domainsService.create({ tokenId, expirationDate })
  }

  logger.info(`ExpirationChange event: Domain ${tokenId} updated`)
}

async function nameChangedHandler(logger: Logger, eventData: EventData, _: Eth, services: RnsServices): Promise<void> {
  const name = eventData.returnValues.name

  const domainsService = services.domains

  const label = name.substring(0, name.indexOf('.'))
  const tokenId = Utils.sha3(label)

  const domain = await Domain.findByPk(tokenId)
  const [affectedRows] = await domainsService.patch(null, { name: name }, { where: { tokenId } })
  console.log('rns.processor.ts -> transferHandler -> affectedRows', affectedRows)

  if (affectedRows) {
    logger.info(`NameChanged event: Updated Domain ${name} -> ${tokenId}`)
  } else {
    logger.info(`NameChanged event: no Domain ${name} updated`)
  }
}

async function tokenPlacedHandler(logger: Logger, eventData: EventData, eth: Eth, services: RnsServices): Promise<void> {
  // event TokenPlaced(uint256 indexed tokenId, address indexed paymentToken, uint256 cost);

  const offersService = services.offers
  const transactionHash = eventData.transactionHash
  const tokenId = Utils.numberToHex(eventData.returnValues.tokenId)
  const paymentToken = eventData.returnValues.paymentToken
  const cost = eventData.returnValues.cost

  const domain = await Domain.findByPk(tokenId)

  if (!domain) {
    throw new Error(`Domain with token ID ${tokenId} not found!`)
  }

  console.log('domain offers:', await offersService.find({
    query: {
      tokenId,
      status: 'ACTIVE'
    }
  }))
  const [affectedRows] = await offersService.patch(null, {
    status: 'CANCELED'
  }, { query: { tokenId, status: 'ACTIVE' } })

  if (affectedRows) {
    logger.info(`TokenPlaced event: ${tokenId} previous placement cancelled`)
  } else {
    logger.info(`TokenPlaced event: ${tokenId} no previous placement`)
  }

  offersService.create({
    offerId: transactionHash,
    sellerAddress: domain.ownerAddress,
    tokenId: tokenId,
    paymentToken: paymentToken,
    price: cost,
    creationDate: await getBlockDate(eth, eventData.blockNumber),
    status: 'ACTIVE'
  })

  logger.info(`TokenPlaced event: ${tokenId} created`)
}

async function tokenUnplacedHandler(logger: Logger, eventData: EventData, eth: Eth, services: RnsServices): Promise<void> {
  // event TokenUnplaced(uint256 indexed tokenId);
  const offersService = services.offers

  const tokenId = Utils.numberToHex(eventData.returnValues.tokenId)

  const [affectedRows] = await offersService.patch(null, {
    status: 'CANCELED'
  }, { where: { tokenId: tokenId, status: 'ACTIVE' } })

  if (affectedRows) {
    logger.info(`TokenUnplaced event: ${tokenId} updated`)
  } else {
    logger.info(`TokenUnplaced event: ${tokenId} not updated`)
  }
}

async function tokenSoldHandler(logger: Logger, eventData: EventData, eth: Eth, services: RnsServices): Promise<void> {
  // event TokenSold(uint256 indexed tokenId);
  const soldService = services.sold

  const transactionHash = eventData.transactionHash
  const tokenId = Utils.numberToHex(eventData.returnValues.tokenId)

  const lastOffer = await DomainOffer.findOne({ where: { tokenId: tokenId, status: 'ACTIVE' } })

  if (lastOffer) {
    logger.info(`Found last offer for ${tokenId}`)
    lastOffer.status = 'SOLD'
    lastOffer.save()

    const soldDomain = await soldService.create({
      id: transactionHash,
      tokenId: tokenId,
      price: lastOffer.price,
      paymentToken: lastOffer.paymentToken,
      soldDate: await getBlockDate(eth, eventData.blockNumber)
    })

    if (soldDomain) {
      logger.info(`TokenSold event: ${tokenId}`)
    } else {
      logger.info(`TokenSold event: ${tokenId} not updated`)
    }
  }
}

const commands = {
  Transfer: transferHandler,
  ExpirationChanged: expirationChangedHandler,
  NameChanged: nameChangedHandler,
  TokenPlaced: tokenPlacedHandler,
  TokenUnplaced: tokenUnplacedHandler,
  TokenSold: tokenSoldHandler
}

function isValidEvent(value: string): value is keyof typeof commands {
  return value in commands
}

export default function rnsProcessorFactory(logger: Logger, eth: Eth, services: RnsServices) {
  return async function (eventData: EventData): Promise<void> {
    if (isValidEvent(eventData.event)) {
      logger.info(`Processing event ${eventData.event}`)
      await commands[eventData.event](logger, eventData, eth, services)
    } else {
      logger.error(`Unknown event ${eventData.event}`)
    }
  }
}

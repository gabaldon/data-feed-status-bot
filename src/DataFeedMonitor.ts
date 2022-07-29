import { GraphQLClient } from 'graphql-request'
import TelegramBot from 'node-telegram-bot-api'

import { fetchFeedsApi } from './fetchFeedsApi'
import { getMsToBeUpdated, isFeedOutdated } from './feedStatus'
import { Feed } from './types'
import { MAINNET_KEYWORDS } from './constants'
import { groupBy } from './groupBy'

enum Network {
  Mainnet,
  Testnet
}
enum StatusEmoji {
  Green = '🟢',
  Yellow = '🟡',
  Red = '🔴'
}
type FeedsStatusByNetwork = Record<FeedName, FeedStatusInfo>
type FeedStatusInfo = {
  isOutdated: boolean
  msToBeUpdated: number
  statusChanged: boolean
  isMainnet: boolean
}
type NetworkName = string
type FeedName = string
type State = Record<NetworkName, Record<FeedName, FeedStatusInfo>>

export class DataFeedMonitor {
  private graphQLClient: GraphQLClient
  private mainnetBot: TelegramBot
  private testnetBot: TelegramBot
  // store data feed name and its last status
  private state: State = {}

  constructor (
    graphQLClient: GraphQLClient,
    {
      mainnetBot,
      testnetBot
    }: { mainnetBot: TelegramBot; testnetBot: TelegramBot },
    state: State = {}
  ) {
    this.graphQLClient = graphQLClient
    this.mainnetBot = mainnetBot
    this.testnetBot = testnetBot
    this.state = state
  }

  public async checkFeedsStatus (dateNow: number = Date.now()) {
    const {
      feeds: { feeds }
    } = await fetchFeedsApi(this.graphQLClient)

    const monitorableFeeds = feeds.filter(feed => feed.heartbeat)

    const feedsByNetwork = groupBy(monitorableFeeds, 'network')
    const isFirstCheck = !Object.keys(this.state).length

    this.state = Object.entries(feedsByNetwork).reduce(
      (state: State, [network, networkFeeds]) => {
        const feedsStatusByNetwork: FeedsStatusByNetwork = groupFeedsStatusByNetwork(
          networkFeeds,
          this.state[network],
          dateNow
        )

        return {
          ...state,
          [network]: feedsStatusByNetwork
        }
      },
      this.state
    )

    const shouldSendMessages = Object.entries(this.state).reduce(
      (acc, [network, networkFeeds]) => {
        const shouldSendMessage = Object.values(networkFeeds).reduce(
          (shouldSendMessage, feed) => shouldSendMessage || feed.statusChanged,
          false
        )

        if (isMainnetFeed(network)) {
          return { ...acc, mainnet: acc.mainnet || shouldSendMessage }
        } else {
          return { ...acc, testnet: acc.testnet || shouldSendMessage }
        }
      },
      { mainnet: false, testnet: false }
    )

    const { mainnetState, testnetState } = splitStateByKind(this.state)

    const createMessages = (state: State) =>
      Object.entries(state).reduce(
        (messages: Array<string>, [network, feeds]) => {
          return [...messages, createNetworkMessage(feeds, network)]
        },
        []
      )
    if (isFirstCheck || shouldSendMessages.mainnet) {
      const messages = createMessages(mainnetState)
      this.sendTelegramMessage(Network.Mainnet, messages.join('\n'))
    }

    if (isFirstCheck || shouldSendMessages.testnet) {
      const messages = createMessages(testnetState)
      this.sendTelegramMessage(Network.Testnet, messages.join('\n'))
    }

    return
  }

  public async sendTelegramMessage (network: Network, message: string) {
    const credentialsByNetwork = {
      [Network.Mainnet]: {
        telegramBot: this.mainnetBot,
        channelId: process.env.CHANNEL_ID_MAINNET
      },
      [Network.Testnet]: {
        telegramBot: this.testnetBot,
        channelId: process.env.CHANNEL_ID_TESTNET
      }
    }
    const { telegramBot, channelId } = credentialsByNetwork[network]

    try {
      // if CHANNEL_ID is not found at the beginning will throw an error
      return await telegramBot.sendMessage(channelId as string, message, {
        parse_mode: 'Markdown'
      })
    } catch (err) {
      console.error(err)
    }
  }
}

function createNetworkMessage (
  feedsStatusByNetwork: FeedsStatusByNetwork,
  network: string
): string {
  const feedInfos = Object.values(feedsStatusByNetwork)

  const outdatedFeeds = feedInfos.filter(feedInfo => feedInfo.isOutdated)
  const outdatedFeedsLength = outdatedFeeds.length
  const feedsLength = feedInfos.length

  const largestDelayMs = Math.min(
    ...outdatedFeeds.map(feedInfo => feedInfo.msToBeUpdated)
  )

  // only use the delay if there are oudated feeds
  const delay = outdatedFeeds.length
    ? formatDelayString(largestDelayMs)
    : undefined

  let color: StatusEmoji
  if (!outdatedFeedsLength) {
    color = StatusEmoji.Green
  } else if (outdatedFeedsLength !== feedsLength) {
    color = StatusEmoji.Yellow
  } else {
    color = StatusEmoji.Red
  }

  const statusHasChanged = feedInfos.find(
    feedStatusInfo => feedStatusInfo.statusChanged
  )

  const message = `${color} ${network} (${feedsLength -
    outdatedFeedsLength}/${feedsLength}) ${delay ?? ''}`.trim()

  return statusHasChanged ? `*${message}*` : message
}

function formatDelayString (msToBeUpdated: number): string {
  let secondsToBeUpdated = Math.floor((-1 * msToBeUpdated) / 1000)

  const days = Math.floor(secondsToBeUpdated / (60 * 60 * 24))
  secondsToBeUpdated -= days * 60 * 60 * 24

  const hours = Math.floor(secondsToBeUpdated / 3600) % 24
  secondsToBeUpdated -= hours * 60 * 60

  const minutes = Math.floor(secondsToBeUpdated / 60) % 60
  secondsToBeUpdated -= minutes * 60

  let timeOutdatedString
  const daysToRequest = Number(process.env.DAYS_TO_REQUEST || '2')
  if (days && days > daysToRequest) {
    timeOutdatedString = `> ${daysToRequest}d`
  } else if (days) {
    timeOutdatedString = `${days}d ${hours}h ${minutes}m`
  } else if (hours) {
    timeOutdatedString = `${hours}h ${minutes}m`
  } else {
    timeOutdatedString = `${minutes}m`
  }
  return timeOutdatedString
}

function groupFeedsStatusByNetwork (
  feeds: Array<Feed>,
  networkFeedsStatus: Record<FeedName, FeedStatusInfo>,
  dateNow: number
): FeedsStatusByNetwork {
  return feeds.reduce((acc: FeedsStatusByNetwork, feed: Feed) => {
    const msToBeUpdated = getMsToBeUpdated(dateNow, feed)
    const isOutdated = isFeedOutdated(msToBeUpdated)
    const statusChanged = acc[feed.feedFullName]?.isOutdated !== isOutdated
    const isMainnet = isMainnetFeed(feed.network)

    return {
      ...acc,
      [feed.feedFullName]: {
        isOutdated,
        msToBeUpdated,
        statusChanged,
        isMainnet
      }
    }
  }, networkFeedsStatus || {})
}

function isMainnetFeed (network: string) {
  return !!MAINNET_KEYWORDS.find(keyword => network.includes(keyword))
}

function splitStateByKind (state: State) {
  return Object.entries(state).reduce(
    (networks, [network, feeds]) => {
      const isMainnet = Object.values(feeds)[0].isMainnet

      return {
        mainnetState: isMainnet
          ? { ...networks.mainnetState, [network]: feeds }
          : networks.mainnetState,
        testnetState: !isMainnet
          ? { ...networks.testnetState, [network]: feeds }
          : networks.testnetState
      }
    },
    { testnetState: {}, mainnetState: {} } as {
      mainnetState: State
      testnetState: State
    }
  )
}

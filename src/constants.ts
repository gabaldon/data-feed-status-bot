export const MAINNET_KEYWORDS = ['mainnet', 'tethys']

export const ADMISSIBLE_DELAY_MS: number =
  Number(process.env.ADMISSIBLE_DELAY_SECONDS || '0') * 1000

export const DAYS_TO_CONSIDER_FEED_INACTIVE = Number(
  process.env.DAYS_TO_CONSIDER_FEED_INACTIVE
)

export const TIME_TO_CONSIDER_FEED_INACTIVE_MS =
  Number(DAYS_TO_CONSIDER_FEED_INACTIVE || '7') * 24 * 3600 * 1000

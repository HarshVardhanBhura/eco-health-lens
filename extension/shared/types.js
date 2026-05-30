/**
 * @typedef {'food' | 'non_food' | 'ambiguous'} ProductType
 */

/**
 * @typedef {'high' | 'medium' | 'low'} Confidence
 */

/**
 * @typedef {'good' | 'warn' | 'bad' | 'neutral'} MacroStatus
 */

/**
 * @typedef {'good' | 'bad' | 'neutral'} IngredientSentiment
 */

/**
 * @typedef {Object} MacroItem
 * @property {string} name
 * @property {number} [value_g]
 * @property {number} [refPercent]
 * @property {MacroStatus} status
 */

/**
 * @typedef {Object} AdditiveFlag
 * @property {string} name
 * @property {'low' | 'medium' | 'high'} severity
 * @property {string} reason
 */

/**
 * @typedef {Object} HealthComponents
 * @property {{ score: number, items: MacroItem[] }} [macros]
 * @property {{ score: number, flags: AdditiveFlag[] }} [additives]
 * @property {{ score: number, nova?: number }} [processing]
 * @property {{ score: number, grade?: string }} [nutriscore]
 */

/**
 * @typedef {Object} HealthRationale
 * @property {string} text
 * @property {'positive' | 'negative' | 'neutral'} type
 */

/**
 * @typedef {Object} HealthResult
 * @property {number} total
 * @property {string} [grade]
 * @property {HealthRationale[]} [rationale]
 * @property {HealthComponents} components
 * @property {boolean} [isAverage]
 * @property {number} [variantCount]
 */

/**
 * @typedef {Object} VariantResult
 * @property {string} id
 * @property {string} name
 * @property {HealthResult} health
 * @property {string} [summaryLine]
 * @property {IngredientItem[]} [ingredients]
 * @property {string} [barcode]
 */

/**
 * @typedef {Object} EcoRationale
 * @property {string} text
 * @property {'positive' | 'negative' | 'neutral'} type
 */

/**
 * @typedef {Object} EcoResult
 * @property {number} total
 * @property {string} [grade]
 * @property {EcoRationale[]} rationale
 */

/**
 * @typedef {Object} IngredientItem
 * @property {string} text
 * @property {IngredientSentiment} sentiment
 * @property {string} [reason]
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {ProductType} productType
 * @property {Confidence} confidence
 * @property {HealthResult | null} health
 * @property {EcoResult | null} eco
 * @property {IngredientItem[]} ingredients
 * @property {string[]} sources
 * @property {string} disclaimer
 * @property {string} [title]
 * @property {string} [asin]
 * @property {VariantResult[]} [variants]
 */

/**
 * @typedef {Object} ProductPayload
 * @property {string} retailer
 * @property {string} asin
 * @property {string} url
 * @property {string} title
 * @property {string} [category]
 * @property {string} [barcode]
 * @property {string} [ingredientsText]
 * @property {Record<string, number | string>} [nutrition]
 * @property {Record<string, boolean | string>} [rawHints]
 */

export {};

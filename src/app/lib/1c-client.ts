const ONE_C_URL_1 =
  process.env.ONE_C_URL_1 ||
  "https://crm.prostor.ae/prostor/hs/Integration/AlqitharaDatabaseCosts";
const ONE_C_URL_2 =
  process.env.ONE_C_URL_2 ||
  "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseLocalCosts";

const ONE_C_PRICES_URL =
  process.env.ONE_C_PRICES_URL ||
  "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabasePrices";
const ONE_C_DISCOUNTS_URL =
  process.env.ONE_C_DISCOUNTS_URL ||
  "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseDiscounts";
const ONE_C_STOCK_URL =
  process.env.ONE_C_STOCK_URL ||
  "https://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseStockBalances";

const ONE_C_USERNAME = process.env.ONE_C_USERNAME;
const ONE_C_PASSWORD = process.env.ONE_C_PASSWORD;

async function fetch1cData(url: string): Promise<{ [key: string]: number }> {
  const headers = new Headers();
  if (ONE_C_USERNAME && ONE_C_PASSWORD) {
    headers.append(
      "Authorization",
      "Basic " + btoa(ONE_C_USERNAME + ":" + ONE_C_PASSWORD)
    );
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch costs from ${url}: ${response.statusText}`
    );
  }

  const data = await response.json();
  return data.Items || {};
}

export async function get1cCosts(): Promise<Map<string, number>> {
  console.log("Fetching costs from 1c...");
  const costs1 = await fetch1cData(ONE_C_URL_1);
  console.log(
    `Fetched ${Object.keys(costs1).length} items from first 1c endpoint.`
  );
  const costs2 = await fetch1cData(ONE_C_URL_2);
  console.log(
    `Fetched ${Object.keys(costs2).length} items from second 1c endpoint.`
  );

  const mergedCosts = new Map<string, number>();

  for (const barcode in costs1) {
    if (costs1.hasOwnProperty(barcode)) {
      mergedCosts.set(barcode, costs1[barcode]);
    }
  }

  for (const barcode in costs2) {
    if (costs2.hasOwnProperty(barcode)) {
      mergedCosts.set(barcode, costs2[barcode]);
    }
  }

  console.log(`Merged costs for ${mergedCosts.size} items.`);
  return mergedCosts;
}

export type OneCProductData = {
  price?: number;
  discountPrice?: number;
  stock: number;
};

export async function get1cProductData(): Promise<
  Map<string, OneCProductData>
> {
  console.log("Fetching prices, discounts, and stock from 1c...");
  const [prices, discounts, stocks] = await Promise.all([
    fetch1cData(ONE_C_PRICES_URL),
    fetch1cData(ONE_C_DISCOUNTS_URL),
    fetch1cData(ONE_C_STOCK_URL),
  ]);

  console.log(`Fetched ${Object.keys(prices).length} prices.`);
  console.log(`Fetched ${Object.keys(discounts).length} discounts.`);
  console.log(`Fetched ${Object.keys(stocks).length} stock balances.`);

  const productData = new Map<string, OneCProductData>();

  for (const barcode in prices) {
    if (prices.hasOwnProperty(barcode)) {
      productData.set(barcode, {
        price: prices[barcode],
        stock: 0, // Default stock
      });
    }
  }

  for (const barcode in discounts) {
    if (discounts.hasOwnProperty(barcode)) {
      const existing = productData.get(barcode) || { stock: 0 };
      existing.discountPrice = discounts[barcode];
      productData.set(barcode, existing);
    }
  }

  for (const barcode in stocks) {
    if (stocks.hasOwnProperty(barcode)) {
      const stockBalance = stocks[barcode];
      if (stockBalance > 0) {
        const existing = productData.get(barcode) || { stock: 0 };
        existing.stock = stockBalance;
        productData.set(barcode, existing);
      }
    }
  }

  console.log(`Merged data for ${productData.size} products.`);
  return productData;
}

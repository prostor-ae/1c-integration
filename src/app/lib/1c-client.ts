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

type OneCSource =
  | "Prices"
  | "Discounts"
  | "Stock"
  | "Alqithara costs"
  | "Local costs";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function oneCFetchError(
  source: OneCSource,
  reason: string,
  cause?: unknown,
): Error {
  return new Error(`1C ${source} fetch failed: ${reason}`, { cause });
}

async function fetch1cData(
  url: string,
  source: OneCSource,
): Promise<Record<string, number>> {
  const username = process.env.ONE_C_USERNAME;
  const password = process.env.ONE_C_PASSWORD;

  const headers = new Headers();
  if (username && password) {
    headers.append("Authorization", "Basic " + btoa(username + ":" + password));
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    throw oneCFetchError(source, formatErrorMessage(error), error);
  }

  if (!response.ok) {
    throw oneCFetchError(
      source,
      `HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (error) {
    throw oneCFetchError(
      source,
      `invalid JSON: ${formatErrorMessage(error)}`,
      error,
    );
  }

  return data.Items || {};
}

export async function fetch1cPrices(): Promise<Record<string, number>> {
  console.log("Fetching prices from 1c...");
  const items = await fetch1cData(ONE_C_PRICES_URL, "Prices");
  console.log(`Fetched ${Object.keys(items).length} prices.`);
  return items;
}

export async function fetch1cDiscounts(): Promise<Record<string, number>> {
  console.log("Fetching discounts from 1c...");
  const items = await fetch1cData(ONE_C_DISCOUNTS_URL, "Discounts");
  console.log(`Fetched ${Object.keys(items).length} discounts.`);
  return items;
}

export async function fetch1cStock(): Promise<Record<string, number>> {
  console.log("Fetching stock from 1c...");
  const items = await fetch1cData(ONE_C_STOCK_URL, "Stock");
  console.log(`Fetched ${Object.keys(items).length} stock balances.`);
  return items;
}

export async function fetch1cAlqitharaCosts(): Promise<Record<string, number>> {
  console.log("Fetching Alqithara costs from 1c...");
  const items = await fetch1cData(ONE_C_URL_1, "Alqithara costs");
  console.log(`Fetched ${Object.keys(items).length} Alqithara cost items.`);
  return items;
}

export async function fetch1cLocalCosts(): Promise<Record<string, number>> {
  console.log("Fetching local costs from 1c...");
  const items = await fetch1cData(ONE_C_URL_2, "Local costs");
  console.log(`Fetched ${Object.keys(items).length} local cost items.`);
  return items;
}

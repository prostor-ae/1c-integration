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

async function fetch1cData(url: string): Promise<Record<string, number>> {
  const username = process.env.ONE_C_USERNAME;
  const password = process.env.ONE_C_PASSWORD;

  const headers = new Headers();
  if (username && password) {
    headers.append("Authorization", "Basic " + btoa(username + ":" + password));
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to fetch from ${url}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.Items || {};
}

export async function fetch1cPrices(): Promise<Record<string, number>> {
  console.log("Fetching prices from 1c...");
  const items = await fetch1cData(ONE_C_PRICES_URL);
  console.log(`Fetched ${Object.keys(items).length} prices.`);
  return items;
}

export async function fetch1cDiscounts(): Promise<Record<string, number>> {
  console.log("Fetching discounts from 1c...");
  const items = await fetch1cData(ONE_C_DISCOUNTS_URL);
  console.log(`Fetched ${Object.keys(items).length} discounts.`);
  return items;
}

export async function fetch1cStock(): Promise<Record<string, number>> {
  console.log("Fetching stock from 1c...");
  const items = await fetch1cData(ONE_C_STOCK_URL);
  console.log(`Fetched ${Object.keys(items).length} stock balances.`);
  return items;
}

export async function fetch1cAlqitharaCosts(): Promise<Record<string, number>> {
  console.log("Fetching Alqithara costs from 1c...");
  const items = await fetch1cData(ONE_C_URL_1);
  console.log(`Fetched ${Object.keys(items).length} Alqithara cost items.`);
  return items;
}

export async function fetch1cLocalCosts(): Promise<Record<string, number>> {
  console.log("Fetching local costs from 1c...");
  const items = await fetch1cData(ONE_C_URL_2);
  console.log(`Fetched ${Object.keys(items).length} local cost items.`);
  return items;
}

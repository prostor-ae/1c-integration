// crm.prostor.ae/tst/hs/Integration/ProstorDatabasePrices
// returns list of all products in 1c and its final price
// response structure is:
// {
//   "Items": {
// barcode: number
// }
// }

// crm.prostor.ae/tst/hs/Integration/ProstorDatabaseDiscounts
// returns list of products 1c which has discount and its discount price
// response structure is:
// {
//   "Items": {
// barcode: number (discount price)
// }
// }

// crm.prostor.ae/tst/hs/Integration/ProstorDatabaseStockBalances
// returns list of products 1c which has stock balance and its stock balance. can return negative stock balance for some products, need to filter them out.
// if item not in the list or stock balance lower then 0, item must be treated like out of stock
// response structure is:
// {
//   "Items": {
// barcode: number (stock balance)
// }
// }

// auth example

// curl --request GET \
//   --url http://crm.prostor.ae/tst/hs/Integration/ProstorDatabaseDiscounts \
//   --header 'authorization: Basic RXhjaGFuZ2U6MDIxMTIwMjU='

// cant be triggered by cron or webhook, only manual request to the system protected by api key
// crm.prostor.ae/prostor/hs/Integration/AlqitharaDatabaseCosts
// returns list of some products 1c and its cost
// response structure is:
// {
//   "Items": {
// barcode: number (cost)
// }
// }

// crm.prostor.ae/tst/hs/Integration/ProstorDatabaseLocalCosts
// returns list of some products 1c and its local cost. if product repeats previous request, it has higher priority then previous request
// response structure is:
// {
//   "Items": {
// barcode: number (local cost)
// }
// }

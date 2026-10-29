# RealtyAPI (live listings)

WalkIn reads live listings through the owner's RealtyAPI account
(`REALTYAPI_KEY` on the backend). Each property site is its own RealtyAPI
"provider" with its own host, `https://{provider}.realtyapi.io`, and every
request sends the `x-realtyapi-key` header.

| Country (from the map point) | Searched | Importable |
| --- | --- | --- |
| United Kingdom | Rightmove | Rightmove, Zoopla |
| United States | Realtor.com | Realtor.com, Zillow |
| Elsewhere | none; the app says listings cover the UK and US | |

Only homes with a floor plan are shown. Rightmove's search results carry
`floorplanCount`, so listings without a plan are dropped before they reach the
globe. Realtor.com's search doesn't say, so its listings are kept and the plan
is checked on import. Zoopla's search doesn't say either and its listings often
lack plans, and Zillow exposes no plans at all, so neither is searched; already
imported listings from them still open.

The country comes from reverse-geocoding the tapped point with OpenStreetMap
Nominatim (`backend/src/providers/geo.ts`, max 1 request per second, cached).

## Endpoints used

Taken from each provider's published `openapi.json`. Response field names come
from one sampled response per endpoint (see "Re-checking" below).

| Provider | Search near a point | Listing details | Media |
| --- | --- | --- | --- |
| Rightmove | `GET /search/bycoordinates?latitude&longitude&radius&searchType=RENT\|BUY&resultCount` → `searchResults[]` and `featured[]` (`id`, `address`, `bedrooms`, `displayPrice`, `floorplanCount`, `photos[]`, `latitude`, `longitude`, `url`) | `GET /details/byid?propertyId` → `detail` (`address`, `postcode`, `transactionType`, `bedrooms`, `price.{primary,numericValue}`, `size.{primary,secondary}`, `fullDescription`, `photos[{url,maxSizeUrl}]`, `floorplans[{url,caption}]`, `location`, `propertyUrl`) | in the details response |
| Zoopla | `GET /search/bycoordinates?latitude&longitude&radius&searchType=To_Rent\|For_Sale` → `searchResults[]` (`listingId`, `address`, `price`, `features.beds`, `photos[]`, `latitude`, `longitude`) | `GET /details/byid?listingId` → `detail` (`displayAddress`, `priceValue`, `rentFrequency`, `beds`, `sizeSqft`, `floorArea`, `photos[]`, `floorPlans[]`) | `GET /images?listingId` → `detail.photos[]`, `detail.floorPlans[]` |
| Zillow | `GET /search/bycoordinates?latitude&longitude&radius&listingStatus=For_Rent\|For_Sale` → `searchResults[].property` (`zpid`, `location`, `address`, `media.propertyPhotoLinks`, `minPrice/maxPrice`) | `GET /byzpid?zpid` → `PropertyAddress`, `Bedrooms`, `Bathrooms`, `Area(sqft)`, `Price`, `PropertyZillowURL` | `GET /propimages?byzpid` → `originalPhotos[].mixedSources.jpeg[]` (no floor plans exposed) |
| Realtor.com | `GET /search/bycoordinates?latitude&longitude&radius&searchType&resultCount&hasPhotos` → `searchResults[]` (`property_id`, `listing_id`, `list_price`, `beds`, `address.{line,city,latitude,longitude}`, `primary_photo`, `photos[]`) | `GET /details/byid?property_id&listing_id` → `detail` (`details.{beds,baths,sqft,text}`, `photos[{href,tags}]`, `floorplans`) | photos tagged as floor plans are treated as plans |

## Behaviour and limits

- **Cost:** searches are cached for 6 hours and details for 24 hours (in memory), up to 25 results per provider (40 for Rightmove, before listings without a plan are dropped). `/api/listings/nearby` and `/api/properties/import` are rate-limited per IP.
- **Media:** on import, up to 4 floor plans and 20 photos are downloaded server-side, only over HTTPS from the providers' image CDNs (`media.rightmove.co.uk`, `*.zoocdn.com`, `photos.zillowstatic.com`, `*.rdcpix.com`), only as jpeg/png/webp/gif, and up to 15 MB each.
- **Floor plans:** the globe lists only homes with a plan (see above). Many Zoopla and Zillow listings have none, which is why they're no longer searched.
- **Rights:** media fetched this way is marked `licensed` (supplied through the owner's account) so it can be sent to Meta models. Check RealtyAPI's terms and the portal's terms before any public or commercial use.

## Re-checking the API

`backend/src/providers/realty-probe.ts` is an opt-in diagnostic:

- `REALTYAPI_PROBE=1`: at start-up, log every provider's endpoints and parameters from the public specs. No searches, no quota.
- `REALTYAPI_PROBE=2`: one sample search plus details per provider (about 9 calls), logging field names and types only (for Rightmove also the first result's values). `REALTYAPI_PROBE_PROVIDERS=rightmove` limits it to the listed providers.
- `REALTYAPI_PROBE=3`: for a few Zoopla listings, look the same property up on Rightmove by address and in Zoopla's listing history (about 20 calls). On 29 Oct 2026 every Rightmove match was a different property: Zoopla gives only a street and outcode, not a house number or full postcode, so matching by address doesn't work.

Set it on the backend, read the deploy logs, then set it back to `0`.

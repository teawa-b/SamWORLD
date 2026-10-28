# RealtyAPI (live listings)

WalkIn reads live listings through the owner's RealtyAPI account
(`REALTYAPI_KEY` on the backend). Each property site is its own RealtyAPI
"provider" with its own host, `https://{provider}.realtyapi.io`, and every
request sends the `x-realtyapi-key` header.

| Country (from the map point) | Providers |
| --- | --- |
| United Kingdom | Zoopla |
| United States | Zillow, Realtor.com |
| Elsewhere | none; the app says listings cover the UK and US |

The country comes from reverse-geocoding the tapped point with OpenStreetMap
Nominatim (`backend/src/providers/geo.ts`, max 1 request per second, cached).

## Endpoints used

Taken from each provider's published `openapi.json`. Response field names come
from one sampled response per endpoint (see "Re-checking" below).

| Provider | Search near a point | Listing details | Media |
| --- | --- | --- | --- |
| Zoopla | `GET /search/bycoordinates?latitude&longitude&radius&searchType=To_Rent\|For_Sale` → `searchResults[]` (`listingId`, `address`, `price`, `features.beds`, `photos[]`, `latitude`, `longitude`) | `GET /details/byid?listingId` → `detail` (`displayAddress`, `priceValue`, `rentFrequency`, `beds`, `sizeSqft`, `floorArea`, `photos[]`, `floorPlans[]`) | `GET /images?listingId` → `detail.photos[]`, `detail.floorPlans[]` |
| Zillow | `GET /search/bycoordinates?latitude&longitude&radius&listingStatus=For_Rent\|For_Sale` → `searchResults[].property` (`zpid`, `location`, `address`, `media.propertyPhotoLinks`, `minPrice/maxPrice`) | `GET /byzpid?zpid` → `PropertyAddress`, `Bedrooms`, `Bathrooms`, `Area(sqft)`, `Price`, `PropertyZillowURL` | `GET /propimages?byzpid` → `originalPhotos[].mixedSources.jpeg[]` (no floor plans exposed) |
| Realtor.com | `GET /search/bycoordinates?latitude&longitude&radius&searchType&resultCount&hasPhotos` → `searchResults[]` (`property_id`, `listing_id`, `list_price`, `beds`, `address.{line,city,latitude,longitude}`, `primary_photo`, `photos[]`) | `GET /details/byid?property_id&listing_id` → `detail` (`details.{beds,baths,sqft,text}`, `photos[{href,tags}]`, `floorplans`) | photos tagged as floor plans are treated as plans |

## Behaviour and limits

- **Cost:** searches are cached for 6 hours and details for 24 hours (in memory), up to 25 results per provider. `/api/listings/nearby` and `/api/properties/import` are rate-limited per IP.
- **Media:** on import, up to 4 floor plans and 20 photos are downloaded server-side, only over HTTPS from the providers' image CDNs (`*.zoocdn.com`, `photos.zillowstatic.com`, `*.rdcpix.com`), only as jpeg/png/webp/gif, and up to 15 MB each.
- **No floor plan, no 3D model:** many listings, especially Zillow rentals, have no floor plan. The listing page says so, and "Explore in 3D" stays disabled.
- **Rights:** media fetched this way is marked `licensed` (supplied through the owner's account) so it can be sent to Meta models. Check RealtyAPI's terms and the portal's terms before any public or commercial use.

## Re-checking the API

`backend/src/providers/realty-probe.ts` is an opt-in diagnostic:

- `REALTYAPI_PROBE=1`: at start-up, log every provider's endpoints and parameters from the public specs. No searches, no quota.
- `REALTYAPI_PROBE=2`: one sample search plus details per provider (about 7 calls), logging field names and types only.

Set it on the backend, read the deploy logs, then set it back to `0`.

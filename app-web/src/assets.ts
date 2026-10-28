import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string => `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'property-menu': {
    url: publicAssetUrl('ui/property-menu.uikitml'),
    type: AssetType.UIKitML,
    name: 'Property Menu',
  },
});

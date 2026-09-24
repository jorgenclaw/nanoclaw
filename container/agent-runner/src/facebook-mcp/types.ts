export interface FacebookConfig {
  pageId: string;
  pageAccessToken: string;
  apiVersion: string;
}

export interface GraphApiResponse<T = unknown> {
  data?: T;
  error?: {
    message: string;
    type: string;
    code: number;
  };
  paging?: {
    cursors?: { before: string; after: string };
    next?: string;
  };
}

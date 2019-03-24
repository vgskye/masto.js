import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as LinkHeader from 'http-link-header';
import * as querystring from 'querystring';
import { MastodonError } from '../errors/mastodon-error';
import { MastodonNotFoundError } from '../errors/mastodon-not-found-error';
import { MastodonRateLimitError } from '../errors/mastodon-rate-limit-error';
import { MastodonUnauthorizedError } from '../errors/mastodon-unauthorized-error';
import { EventHandler } from './event-handler';

/** Type to determine whether paginate-able entity */
export type Paginatable = string[] | { id: string }[];

export type PaginateNextOptions<Params> = {
  /** Reset pagination */
  reset?: boolean;

  /** URL */
  url?: string;

  /** Query parameters */
  params?: Params;
};

/**
 * Mastodon network request wrapper
 * @param options Optional params
 * @param options.url URL of the instance
 * @param options.streamingUrl Streaming API URL of the instance
 * @param options.token API token of the user
 */
export class Gateway {
  /** URI of the instance */
  public uri = '';

  /** Version of the current instance */
  public version = '';

  /** Streaming API URL of the instance */
  public streamingUrl = '';

  /** API token of the user */
  public token = '';

  protected constructor(options: {
    uri: string;
    streamingUrl?: string;
    version?: string;
    token?: string;
  }) {
    this.uri = options.uri;

    if (options.streamingUrl) {
      this.streamingUrl = options.streamingUrl;
    }

    if (options.version) {
      this.version = options.version;
    }

    if (options.token) {
      this.token = options.token;
    }
  }

  /**
   * Fetch API wrapper function
   * @param options Axios options
   * @param parse Whether parse response before return
   * @return Parsed response object
   */
  protected async request<T>(
    options: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    if (!options.headers) {
      options.headers = {};
    }

    if (!options.headers['Content-Type']) {
      options.headers['Content-Type'] = 'application/json';
    }

    if (this.token) {
      options.headers.Authorization = `Bearer ${this.token}`;
    }

    options.transformResponse = [
      (data: any) => {
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      },
    ];

    try {
      return await axios.request<T>(options);
    } catch (error) {
      const { status } = error && error.response;

      // Error response from REST API might contain error key
      // https://docs.joinmastodon.org/api/entities/#error
      const { error: errorMessage } =
        error && error.response && error.response.data;

      switch (status) {
        case 401:
          throw new MastodonUnauthorizedError(errorMessage);
        case 404:
          throw new MastodonNotFoundError(errorMessage);
        case 429:
          throw new MastodonRateLimitError(errorMessage);
        default:
          throw new MastodonError(
            'MastodonError',
            errorMessage || 'Unexpected error occurred',
          );
      }
    }
  }

  /**
   * HTTP GET
   * @param url URL to request
   * @param params Query strings
   * @param options Fetch API options
   * @param parse Whether parse response before return
   */
  protected get<T>(url: string, params = {}, options = {}) {
    return this.request<T>({
      method: 'GET',
      url:
        url +
        (Object.keys(params).length ? `?${querystring.stringify(params)}` : ''),
      ...options,
    });
  }

  /**
   * HTTP POST
   * @param url URL to request
   * @param body Payload
   * @param options Fetch API options
   * @param parse Whether parse response before return
   */
  protected post<T>(url: string, body = {}, options = {}) {
    return this.request<T>({
      method: 'POST',
      url,
      data: JSON.stringify(body),
      ...options,
    });
  }

  /**
   * HTTP PUT
   * @param url URL to request
   * @param body Payload
   * @param options Fetch API options
   * @param parse Whether parse response before return
   */
  protected put<T>(url: string, body = {}, options = {}) {
    return this.request<T>({
      method: 'PUT',
      url,
      data: JSON.stringify(body),
      ...options,
    });
  }

  /**
   * HTTP DELETE
   * @param url URL to request
   * @param body Payload
   * @param options Fetch API options
   * @param parse Whether parse response before return
   */
  protected delete<T>(url: string, body = {}, options = {}) {
    return this.request<T>({
      method: 'DELETE',
      url,
      data: JSON.stringify(body),
      ...options,
    });
  }

  /**
   * HTTP PATCH
   * @param url URL to request
   * @param body Payload
   * @param options Fetch API options
   * @param parse Whether parse response before return
   */
  protected patch<T>(url: string, body = {}, options = {}) {
    return this.request<T>({
      method: 'PATCH',
      url,
      data: JSON.stringify(body),
      ...options,
    });
  }

  /**
   * Connect to a streaming
   * @param id ID of the channel, e.g. `public`, `user`, `public:local`
   * @return Instance of EventEmitter
   */
  protected stream(url: string, params: { [key: string]: string }) {
    if (this.token) {
      params.access_token = this.token;
    }

    return new EventHandler().connect(url, params);
  }

  /**
   * Generate an iterable of the pagination.
   * The default generator implementation of JS cannot change the value of `done` depend on the result of yield,
   * Therefore we define custom generator to reproduce Mastodon's link header behaviour faithfully.
   * @param initialUrl URL for the endpoint
   * @param initialParams Query parameter
   * @return Async iterable iterator of the pages.
   * See also [MDN article about generator/iterator](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Iterators_and_Generators)
   */
  protected paginate<Data extends Paginatable, Params = any>(
    initialUrl: string,
    initialParams?: Params,
  ): AsyncIterableIterator<Data | undefined> {
    const get = this.get;

    let url: string = initialUrl;
    let params: Params | undefined = initialParams;

    return {
      async next(value?: PaginateNextOptions<Params>) {
        if (value && value.reset) {
          url = initialUrl;
          params = initialParams;
        }

        const response = await get<Data>(
          (value && value.url) || url,
          (value && value.params) || params,
        );

        // Set next url from the link header
        const link = response.headers.get('Link') || '';
        const next = LinkHeader.parse(link).refs.find(
          ({ rel }) => rel === 'next',
        );

        if (!next || !next.uri) {
          return { done: true, value: undefined };
        }

        url = next.uri;
        params = undefined;

        // Return `done: true` immediately if no next url returned
        return { done: !url, value: response.data };
      },

      async return(value: Data) {
        return { value, done: true };
      },

      async throw(error?: Error) {
        throw error;
      },

      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

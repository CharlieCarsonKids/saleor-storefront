import { InMemoryCache } from "apollo-cache-inmemory";
import { ApolloClient, ApolloError, ObservableQuery } from "apollo-client";
import { ApolloLink } from "apollo-link";
import { BatchHttpLink } from "apollo-link-batch-http";
import { RetryLink } from "apollo-link-retry";
import { GraphQLError } from "graphql";
import urljoin from "url-join";

import { TokenAuth } from "../components/User/types/TokenAuth";
import { authLink, getAuthToken, invalidTokenLink, setAuthToken } from "./auth";
import { MUTATIONS } from "./mutations";
import { QUERIES } from "./queries";
import {
  InferOptions,
  MapFn,
  QueryShape,
  WatchMapFn,
  WatchQueryData
} from "./types";
import { getErrorsFromData, getMappedData, isDataEmpty } from "./utils";

const { invalidLink } = invalidTokenLink();
const getLink = (url?: string) =>
  ApolloLink.from([
    invalidLink,
    authLink,
    new RetryLink(),
    new BatchHttpLink({ uri: urljoin(url || "/", "/graphql/") }),
  ]);

export const createSaleorClient = (url?: string, cache = new InMemoryCache()) =>
  new ApolloClient({
    cache,
    defaultOptions: {
      mutate: {
        errorPolicy: "all",
      },
      query: {
        errorPolicy: "all",
        fetchPolicy: "network-only",
      },
      watchQuery: {
        errorPolicy: "all",
        fetchPolicy: "cache-and-network",
      },
    },
    link: getLink(url),
  });

export class SaleorAPI {
  getProductDetails = this.watchQuery(
    QUERIES.ProductDetails,
    data => data.product
  );

  getUserDetails = this.watchQuery(QUERIES.UserDetails, data => data.me);

  getUserOrderDetails = this.watchQuery(
    QUERIES.UserOrders,
    data => data.orderByToken
  );

  setUserDefaultAddress = this.fireQuery(
    MUTATIONS.AddressTypeUpdate,
    data => data!.addressSetDefault
  );

  setDeleteUserAddress = this.fireQuery(
    MUTATIONS.DeleteUserAddress,
    data => data!.addressDelete
  );

  private client: ApolloClient<any>;

  constructor(client: ApolloClient<any>) {
    this.client = client;
  }

  signIn = (
    variables: InferOptions<MUTATIONS["TokenAuth"]>["variables"],
    options?: Omit<InferOptions<MUTATIONS["TokenAuth"]>, "variables">
  ) =>
    new Promise<{ data: TokenAuth["tokenCreate"] }>(async (resolve, reject) => {
      try {
        const data = await this.fireQuery(
          MUTATIONS.TokenAuth,
          data => data!.tokenCreate
        )(variables, {
          ...options,
          update: (proxy, data) => {
            const handledData = handleDataErrors(
              data => data.tokenCreate,
              data.data,
              data.errors
            );
            if (!handledData.errors && handledData.data) {
              setAuthToken(handledData.data.token);
              if (window.PasswordCredential && variables) {
                navigator.credentials.store(
                  new window.PasswordCredential({
                    id: variables.email,
                    password: variables.password,
                  })
                );
              }
            }
            if (options && options.update) {
              options.update(proxy, data);
            }
          },
        });

        resolve(data);
      } catch (e) {
        reject(e);
      }
    });

  attachAuthListener = (callback: (authenticated: boolean) => void) => {
    const eventHandler = () => {
      callback(this.isLoggedIn());
    };

    addEventListener("auth", eventHandler);

    return () => {
      removeEventListener("auth", eventHandler);
    };
  };

  isLoggedIn = () => {
    return !!getAuthToken();
  };

  // Query and mutation wrapper to catch errors
  private watchQuery<T extends QueryShape, TResult>(
    query: T,
    mapFn: WatchMapFn<T, TResult>
  ) {
    return (
      variables: InferOptions<T>["variables"],
      options: Omit<InferOptions<T>, "variables"> & {
        onComplete?: () => void;
        onError?: (error: ApolloError) => void;
        onUpdate: (data: ReturnType<typeof mapFn> | null) => void;
      }
    ) => {
      const { onComplete, onError, onUpdate, ...apolloClientOptions } = options;

      const observable: ObservableQuery<
        WatchQueryData<T>,
        InferOptions<T>["variables"]
      > = query(this.client, {
        ...apolloClientOptions,
        variables,
      });

      observable.subscribe(
        result => {
          const { data, errors: apolloErrors } = result;
          const errorHandledData = handleDataErrors(
            mapFn,
            data as any,
            apolloErrors
          );
          if (onUpdate) {
            if (errorHandledData.errors) {
              if (onError) {
                onError(errorHandledData.errors);
              }
            } else {
              onUpdate(errorHandledData.data as TResult);
              if (onComplete) {
                onComplete();
              }
            }
          }
        },
        error => {
          if (onError) {
            onError(error);
          }
        }
      );

      return {
        refetch: (variables?: InferOptions<T>["variables"]) => {
          if (variables) {
            observable.setVariables(variables);
            const cachedResult = observable.currentResult();
            const errorHandledData = handleDataErrors(mapFn, cachedResult.data);
            if (errorHandledData.data) {
              onUpdate(errorHandledData.data as TResult);
            }
          }

          return this.firePromise(() => observable.refetch(variables), mapFn);
        },
        setOptions: (options?: Omit<InferOptions<T>, "variables">) =>
          this.firePromise(() => observable.setOptions(options), mapFn),
      };
    };
  }

  private fireQuery<T extends QueryShape, TResult>(
    query: T,
    mapFn: MapFn<T, TResult>
  ) {
    return (
      variables: InferOptions<T>["variables"],
      options?: Omit<InferOptions<T>, "variables">
    ) =>
      this.firePromise(
        () =>
          query(this.client, {
            ...options,
            variables,
          }),
        mapFn
      );
  }

  // Promise wrapper to catch errors
  private firePromise<T extends () => Promise<any>, TResult>(
    promise: T,
    mapFn: MapFn<T, TResult>
  ) {
    return new Promise<{ data: ReturnType<typeof mapFn> | null }>(
      async (resolve, reject) => {
        try {
          const { data, errors: apolloErrors } = await promise();
          const errorHandledData = handleDataErrors(mapFn, data, apolloErrors);

          if (errorHandledData.errors) {
            reject(errorHandledData.errors);
          }

          resolve({ data: errorHandledData.data });
        } catch (error) {
          reject(error);
        }
      }
    );
  }
}

// error handler
const handleDataErrors = <T extends QueryShape, TData>(
  mapFn: MapFn<T, TData> | WatchMapFn<T, TData>,
  data: TData,
  apolloErrors?: readonly GraphQLError[]
) => {
  // INFO: user input errors will be moved to graphql errors
  const userInputErrors = getErrorsFromData(data);
  const errors =
    apolloErrors || userInputErrors
      ? new ApolloError({
          extraInfo: userInputErrors,
          graphQLErrors: apolloErrors,
        })
      : null;

  if (errors && isDataEmpty(data)) {
    return { errors };
  }

  const result = getMappedData(mapFn, data);

  return { data: result };
};

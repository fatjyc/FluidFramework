/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryBaseLogger } from "@prague/container-definitions";
import * as resources from "@prague/gitresources";
import {
  IClient,
  IDocumentDeltaConnection,
  IDocumentDeltaStorageService,
  IDocumentService,
  IDocumentStorageService,
  IErrorTrackingService,
} from "@prague/protocol-definitions";
import { DocumentDeltaConnection } from "@prague/socket-storage-shared";
import * as io from "socket.io-client";
import { IFetchWrapper } from "../fetchWrapper";
import { DocumentDeltaStorageService, OdspDeltaStorageService } from "../OdspDeltaStorageService";
import { OdspDocumentStorageManager } from "../OdspDocumentStorageManager";
import { OdspDocumentStorageService } from "../OdspDocumentStorageService";
import { TokenProvider } from "../tokenProvider";
import { getSocketStorageDiscovery } from "../Vroom";
import { IWebsocketEndpoint } from "./contracts";

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class ExperimentalOdspDocumentService implements IDocumentService {
  // This is used to differentiate the initial connection to the delta stream vs a reconnect attempt
  private attemptedDeltaStreamConnection: boolean;

  // This should be used to make web socket endpoint requests, it ensures we only have one active join session call at a time.
  private readonly websocketEndpointRequestThrottler: SinglePromise<IWebsocketEndpoint>;

  // This is the result of a call to websocketEndpointSingleP, it is used to make sure that we don't make two join session
  // calls to handle connecting to delta storage and delta stream.
  private websocketEndpointP: Promise<IWebsocketEndpoint>;

  /**
   * @param appId - app id used for telemetry for network requests
   * @param hashedDocumentId - A unique identifer for the document. The "hashed" here implies that the contents of this string
   * contains no end user identifiable information.
   * @param siteUrl - the url of the site that hosts this container
   * @param driveId - the id of the drive that hosts this container
   * @param itemId - the id of the container within the drive
   * @param snapshotStorageUrl - the URL where snapshots should be obtained from
   * @param getStorageToken - function that can provide the storage token for a given site. This is
   * is also referred to as the "VROOM" token in SPO.
   * @param getWebsocketToken - function that can provide a token for accessing the web socket. This is also
   * referred to as the "Push" token in SPO.
   * @param logger - a logger that can capture performance and diagnostic information
   * @param storageFetchWrapper - if not provided FetchWrapper will be used
   * @param deltasFetchWrapper - if not provided FetchWrapper will be used
   */
  constructor(
    private readonly appId: string,
    private readonly hashedDocumentId: string,
    private readonly siteUrl: string,
    driveId: string,
    itemId: string,
    private readonly snapshotStorageUrl: string,
    readonly getStorageToken: (siteUrl: string) => Promise<string | null>,
    readonly getWebsocketToken: () => Promise<string | null>,
    logger: ITelemetryBaseLogger,
    private readonly storageFetchWrapper: IFetchWrapper,
    private readonly deltasFetchWrapper: IFetchWrapper,
  ) {
    this.websocketEndpointRequestThrottler = new SinglePromise(() =>
      getSocketStorageDiscovery(
        appId,
        driveId,
        itemId,
        siteUrl,
        logger,
        true /* usePushAuthV2 */,
        getStorageToken,
        getWebsocketToken,
      ),
    );

    this.attemptedDeltaStreamConnection = false;
    this.websocketEndpointP = this.websocketEndpointRequestThrottler.response;
  }

  /**
   * Connects to a storage endpoint for snapshot service.
   *
   * @returns returns the document storage service for sharepoint driver.
   */
  public async connectToStorage(): Promise<IDocumentStorageService> {
    // TODO: Remove these parameters to OdspDocumentStorageManager once we have removed the legacy driver
    const blobs: resources.IBlob[] | undefined = undefined;
    const trees: resources.ITree[] | undefined = undefined;
    const latestSha: string | null | undefined = undefined;

    return new OdspDocumentStorageService(
      new OdspDocumentStorageManager(
        { app_id: this.appId },
        this.hashedDocumentId,
        this.snapshotStorageUrl,
        latestSha,
        trees,
        blobs,
        this.storageFetchWrapper,
        () => this.getTokenProvider(),
      ),
    );
  }

  /**
   * Connects to a delta storage endpoint for getting ops between a range.
   *
   * @returns returns the document delta storage service for sharepoint driver.
   */
  public async connectToDeltaStorage(): Promise<IDocumentDeltaStorageService> {
    const ops = undefined;

    const websocketEndpoint = await this.websocketEndpointP;

    return new DocumentDeltaStorageService(
      websocketEndpoint.tenantId,
      websocketEndpoint.id,
      await this.getTokenProvider(),
      new OdspDeltaStorageService(
        { app_id: this.appId },
        websocketEndpoint.deltaStorageUrl,
        this.deltasFetchWrapper,
        ops,
        () => this.getTokenProvider(),
      ),
    );
  }

  /**
   * Connects to a delta stream endpoint for emitting ops.
   *
   * @returns returns the document delta stream service for sharepoint driver.
   */
  public async connectToDeltaStream(client: IClient): Promise<IDocumentDeltaConnection> {
    // TODO: we should add protection to ensure we are only ever processing one connectToDeltaStream

    // when it's not the first time through it means we are trying to reconnect to a disconnected websocket.
    // In this scenario we should refresh our knowledge before attempting to connect
    if (this.attemptedDeltaStreamConnection) {
      this.websocketEndpointP = this.websocketEndpointRequestThrottler.response;
    }
    this.attemptedDeltaStreamConnection = true;

    const websocketEndpoint = await this.websocketEndpointP;

    return DocumentDeltaConnection.create(
      websocketEndpoint.tenantId,
      websocketEndpoint.id,
      await this.getWebsocketToken(),
      io,
      client,
      websocketEndpoint.deltaStreamSocketUrl,
    );
  }

  public async branch(): Promise<string> {
    return "";
  }

  public getErrorTrackingService(): IErrorTrackingService {
    return { track: () => null };
  }

  private async getTokenProvider(): Promise<TokenProvider> {
    const [storageToken, websocketToken] = await Promise.all([
      this.getStorageToken(this.siteUrl),
      this.getWebsocketToken(),
    ]);

    return new TokenProvider(storageToken, websocketToken);
  }
}

/**
 * Utility that makes sure that an expensive function fn
 * only has a single running instance at a time. For example,
 * this can ensure that only a single web request is pending at a
 * given time.
 */
class SinglePromise<T> {
  private pResponse: Promise<T> | undefined;
  private active: boolean;
  constructor(private readonly fn: () => Promise<T>) {
    this.active = false;
  }

  public get response(): Promise<T> {
    // if we are actively running and we have a response return it
    if (this.active && this.pResponse) {
      return this.pResponse;
    }

    this.active = true;
    this.pResponse = this.fn()
      .then((response) => {
        this.active = false;
        return response;
      })
      .catch((e) => {
        this.active = false;
        return Promise.reject(e);
      });

    return this.pResponse;
  }
}

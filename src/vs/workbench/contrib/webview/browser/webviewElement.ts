/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from 'vs/base/browser/dom';
import { IDisposable } from 'vs/base/common/lifecycle';
import { isWeb } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IFileService } from 'vs/platform/files/common/files';
import { ITunnelService } from 'vs/platform/remote/common/tunnel';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { loadLocalResource, WebviewResourceResponse } from 'vs/platform/webview/common/resourceLoader';
import { WebviewPortMappingManager } from 'vs/platform/webview/common/webviewPortMapping';
import { BaseWebview, WebviewMessageChannels } from 'vs/workbench/contrib/webview/browser/baseWebviewElement';
import { WebviewThemeDataProvider } from 'vs/workbench/contrib/webview/browser/themeing';
import { Webview, WebviewContentOptions, WebviewExtensionDescription, WebviewOptions } from 'vs/workbench/contrib/webview/browser/webview';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';

export class IFrameWebview extends BaseWebview<HTMLIFrameElement> implements Webview {
	private readonly _portMappingManager: WebviewPortMappingManager;

	constructor(
		id: string,
		options: WebviewOptions,
		contentOptions: WebviewContentOptions,
		extension: WebviewExtensionDescription | undefined,
		webviewThemeDataProvider: WebviewThemeDataProvider,
		@ITunnelService tunnelService: ITunnelService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IWorkbenchEnvironmentService private readonly _workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
	) {
		super(id, options, contentOptions, extension, webviewThemeDataProvider, telemetryService, environmentService, _workbenchEnvironmentService);

		if (!this.useExternalEndpoint && (!_workbenchEnvironmentService.options || typeof _workbenchEnvironmentService.webviewExternalEndpoint !== 'string')) {
			throw new Error('To use iframe based webviews, you must configure `environmentService.webviewExternalEndpoint`');
		}

		this._portMappingManager = this._register(new WebviewPortMappingManager(
			() => this.extension?.location,
			() => this.content.options.portMapping || [],
			tunnelService
		));

		this._register(this.on(WebviewMessageChannels.loadResource, (entry: any) => {
			const rawPath = entry.path;
			const normalizedPath = decodeURIComponent(rawPath);
			const uri = URI.parse(normalizedPath.replace(/^\/(\w+)\/(.+)$/, (_, scheme, path) => scheme + ':/' + path));
			this.loadResource(rawPath, uri);
		}));

		this._register(this.on(WebviewMessageChannels.loadLocalhost, (entry: any) => {
			this.localLocalhost(entry.origin);
		}));
	}

	protected createElement(options: WebviewOptions, contentOptions: WebviewContentOptions) {
		const element = document.createElement('iframe');
		element.className = `webview ${options.customClasses || ''}`;
		element.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');
		element.setAttribute('src', `${this.externalEndpoint}/index.html?id=${this.id}`);
		element.style.border = 'none';
		element.style.width = '100%';
		element.style.height = '100%';
		return element;
	}

	private get externalEndpoint(): string {
		const endpoint = this.workbenchEnvironmentService.webviewExternalEndpoint!.replace('{{uuid}}', this.id);
		if (endpoint[endpoint.length - 1] === '/') {
			return endpoint.slice(0, endpoint.length - 1);
		}
		return endpoint;
	}

	private get useExternalEndpoint(): boolean {
		return isWeb || this._configurationService.getValue<boolean>('webview.experimental.useExternalEndpoint');
	}

	public mountTo(parent: HTMLElement) {
		if (this.element) {
			parent.appendChild(this.element);
		}
	}

	public set html(value: string) {
		super.html = this.preprocessHtml(value);
	}

	private preprocessHtml(value: string): string {
		return value
			.replace(/(["'])(?:vscode-resource):(\/\/([^\s\/'"]+?)(?=\/))?([^\s'"]+?)(["'])/gi, (match, startQuote, _1, scheme, path, endQuote) => {
				if (scheme) {
					return `${startQuote}${this.externalEndpoint}/vscode-resource/${scheme}${path}${endQuote}`;
				}
				return `${startQuote}${this.externalEndpoint}/vscode-resource/file${path}${endQuote}`;
			})
			.replace(/(["'])(?:vscode-webview-resource):(\/\/[^\s\/'"]+\/([^\s\/'"]+?)(?=\/))?([^\s'"]+?)(["'])/gi, (match, startQuote, _1, scheme, path, endQuote) => {
				if (scheme) {
					return `${startQuote}${this.externalEndpoint}/vscode-resource/${scheme}${path}${endQuote}`;
				}
				return `${startQuote}${this.externalEndpoint}/vscode-resource/file${path}${endQuote}`;
			});
	}

	protected get extraContentOptions() {
		return {
			endpoint: this.externalEndpoint,
		};
	}

	focus(): void {
		if (this.element) {
			this._send('focus');
		}
	}

	showFind(): void {
		throw new Error('Method not implemented.');
	}

	hideFind(): void {
		throw new Error('Method not implemented.');
	}

	runFindAction(previous: boolean): void {
		throw new Error('Method not implemented.');
	}

	private async loadResource(requestPath: string, uri: URI) {
		try {
			const result = await loadLocalResource(uri, this.fileService, this.extension ? this.extension.location : undefined,
				this.content.options.localResourceRoots || []);

			if (result.type === WebviewResourceResponse.Type.Success) {
				return this._send('did-load-resource', {
					status: 200,
					path: requestPath,
					mime: result.mimeType,
					data: result.buffer.buffer,
				});
			}
		} catch  {
			// noop
		}

		return this._send('did-load-resource', {
			status: 404,
			path: requestPath
		});
	}

	private async localLocalhost(origin: string) {
		const authority = this._workbenchEnvironmentService.configuration.remoteAuthority;
		const resolveAuthority = authority ? await this._remoteAuthorityResolverService.resolveAuthority(authority) : undefined;
		const redirect = resolveAuthority ? await this._portMappingManager.getRedirect(resolveAuthority.authority, origin) : undefined;
		return this._send('did-load-localhost', {
			origin,
			location: redirect
		});
	}

	protected doPostMessage(channel: string, data?: any): void {
		if (this.element) {
			this.element.contentWindow!.postMessage({ channel, args: data }, '*');
		}
	}

	protected on<T = unknown>(channel: WebviewMessageChannels, handler: (data: T) => void): IDisposable {
		return addDisposableListener(window, 'message', e => {
			if (!e || !e.data || e.data.target !== this.id) {
				return;
			}
			if (e.data.channel === channel) {
				handler(e.data.data);
			}
		});
	}
}

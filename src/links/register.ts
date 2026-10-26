import type HeronPlugin from '../main';
import { CodeEmbed } from '../ui/embed/CodeEmbed';
import { normalizeFolderInput } from '../utils/paths';
import { EMBED_LANGUAGE, LINK_ACTION, locationFromParams, parseEmbed } from './sourceLink';

/**
 * Registers `obsidian://heron` links and ```heron embeds. Both open their
 * file in a code tab at their lines: links in a new tab, since they come
 * from outside the current note; embeds in the same tab unless Mod is held.
 */
export function registerLinks(plugin: HeronPlugin) {
	plugin.registerObsidianProtocolHandler(LINK_ACTION, (params) => {
		const loc = locationFromParams(params);
		if (loc) void plugin.openLocation(loc, true);
	});

	plugin.registerMarkdownCodeBlockProcessor(EMBED_LANGUAGE, (source, el, ctx) => {
		const spec = parseEmbed(source, normalizeFolderInput);
		if ('error' in spec) {
			el.createDiv({ cls: 'heron-embed heron-embed-message heron-embed-error', text: spec.error });
			return;
		}
		ctx.addChild(new CodeEmbed(el, spec, (loc, newTab) => { void plugin.openLocation(loc, newTab); }));
	});
}

package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/net/html"
)

var parseModes = []string{"text", "main", "markdown"}

var (
	textChromeTags = []string{"script", "style", "nav", "header", "footer"}
	mainChromeTags = append(append([]string{}, textChromeTags...), "aside", "form", "noscript")
	// The first of these with enough text is a page's main content, in "main" and "markdown"
	// modes.
	mainSelectors = []string{
		"article", "main", "[role='main']", "#content", "#main", "#main-content",
		".post-content", ".entry-content", ".article-body", ".article-content", ".post-body",
		".markdown-body",
	}
	spaces       = regexp.MustCompile(`\s+`)
	blankLines   = regexp.MustCompile(`\n{3,}`)
	labelBreaker = regexp.MustCompile(`[\r\n\[\]]`)
)

// htmlToText extracts what a model should read of a page: in "text" mode its text without
// scripts, styles and navigation; in "main" mode only its main content; in "markdown" mode
// that content with its headings, lists and links.
func htmlToText(page, mode string) (string, error) {
	doc, err := html.Parse(strings.NewReader(page))
	if err != nil {
		return "", fmt.Errorf("parse page: %w", err)
	}
	switch mode {
	case "text":
		stripTags(doc, textChromeTags)
		return collapseWhitespace(text(doc, "", false)), nil
	case "main", "markdown":
		stripTags(doc, mainChromeTags)
		root := mainRoot(doc)
		if mode == "main" {
			return collapseWhitespace(text(root, "", false)), nil
		}
		var parts []string
		renderMarkdown(root, &parts)
		return strings.TrimSpace(blankLines.ReplaceAllString(strings.Join(parts, "\n"), "\n\n")), nil
	default:
		return "", fmt.Errorf("unknown parse mode '%s'. Supported: %s", mode, strings.Join(parseModes, ", "))
	}
}

func stripTags(n *html.Node, tags []string) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type == html.ElementNode && contains(tags, c.Data) {
			n.RemoveChild(c)
		} else {
			stripTags(c, tags)
		}
		c = next
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// text joins the text under n with sep, each piece trimmed and empty ones left out when strip
// is set, as BeautifulSoup's get_text does.
func text(n *html.Node, sep string, strip bool) string {
	var pieces []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			s := n.Data
			if strip {
				s = strings.TrimSpace(s)
				if s == "" {
					return
				}
			}
			pieces = append(pieces, s)
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(pieces, sep)
}

func collapseWhitespace(s string) string {
	var chunks []string
	for _, line := range strings.Split(s, "\n") {
		for _, phrase := range strings.Split(strings.TrimSpace(line), "  ") {
			if phrase = strings.TrimSpace(phrase); phrase != "" {
				chunks = append(chunks, phrase)
			}
		}
	}
	return strings.TrimSpace(spaces.ReplaceAllString(strings.Join(chunks, " "), " "))
}

func mainRoot(doc *html.Node) *html.Node {
	for _, selector := range mainSelectors {
		if found := selectOne(doc, selector); found != nil && len(text(found, " ", true)) >= 40 {
			return found
		}
	}
	if body := selectOne(doc, "body"); body != nil {
		return body
	}
	return doc
}

// selectOne finds the first element, in document order, that a selector of the forms
// mainSelectors and search results use matches: tag, #id, .class, [attr='value'], or a
// tag or class followed by a descendant tag.
func selectOne(n *html.Node, selector string) *html.Node {
	all := selectAll(n, selector, 1)
	if len(all) == 0 {
		return nil
	}
	return all[0]
}

func selectAll(n *html.Node, selector string, limit int) []*html.Node {
	var found []*html.Node
	var walk func(*html.Node)
	walk = func(c *html.Node) {
		if limit > 0 && len(found) >= limit {
			return
		}
		if c.Type == html.ElementNode && matches(c, selector) {
			found = append(found, c)
		}
		for k := c.FirstChild; k != nil; k = k.NextSibling {
			walk(k)
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walk(c)
	}
	return found
}

func matches(n *html.Node, selector string) bool {
	switch {
	case strings.HasPrefix(selector, "#"):
		return attr(n, "id") == selector[1:]
	case strings.HasPrefix(selector, "."):
		return hasClass(n, selector[1:])
	case strings.HasPrefix(selector, "["):
		name, value, _ := strings.Cut(strings.Trim(selector, "[]"), "=")
		return attr(n, name) == strings.Trim(value, `'"`)
	default:
		return n.Data == selector
	}
}

func attr(n *html.Node, name string) string {
	for _, a := range n.Attr {
		if a.Key == name {
			return a.Val
		}
	}
	return ""
}

func hasClass(n *html.Node, class string) bool {
	for _, c := range strings.Fields(attr(n, "class")) {
		if c == class {
			return true
		}
	}
	return false
}

func safeMarkdownHref(href string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.TrimSpace(href) {
		if r >= ' ' && r != '\r' && r != '\n' {
			b.WriteRune(r)
		}
	}
	cleaned := b.String()
	if cleaned == "" || strings.IndexFunc(cleaned, unicode.IsSpace) >= 0 {
		return "", false
	}
	u, err := url.Parse(cleaned)
	if err != nil || (strings.ToLower(u.Scheme) != "http" && strings.ToLower(u.Scheme) != "https") || u.Host == "" {
		return "", false
	}
	return strings.ReplaceAll(cleaned, ")", "%29"), true
}

func inlineMarkdown(n *html.Node) string {
	if n.Type == html.TextNode {
		return spaces.ReplaceAllString(n.Data, " ")
	}
	if n.Type == html.ElementNode {
		switch n.Data {
		case "br":
			return "\n"
		case "a":
			label := strings.TrimSpace(labelBreaker.ReplaceAllString(text(n, " ", true), ""))
			if href, ok := safeMarkdownHref(attr(n, "href")); ok && label != "" {
				return "[" + label + "](" + href + ")"
			}
			return label
		case "code":
			return "`" + text(n, "", false) + "`"
		case "strong", "b":
			if inner := text(n, " ", true); inner != "" {
				return "**" + inner + "**"
			}
			return ""
		case "em", "i":
			if inner := text(n, " ", true); inner != "" {
				return "*" + inner + "*"
			}
			return ""
		}
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(inlineMarkdown(c))
	}
	return b.String()
}

func renderMarkdown(n *html.Node, parts *[]string) {
	if n.Type == html.TextNode {
		if s := strings.TrimSpace(n.Data); s != "" {
			*parts = append(*parts, s)
		}
		return
	}
	if n.Type != html.ElementNode && n.Type != html.DocumentNode {
		return
	}
	switch name := n.Data; {
	case n.Type == html.ElementNode && len(name) == 2 && name[0] == 'h' && name[1] >= '1' && name[1] <= '6':
		*parts = append(*parts, strings.Repeat("#", int(name[1]-'0'))+" "+text(n, " ", true), "")
	case name == "p":
		if s := strings.TrimSpace(inlineMarkdown(n)); s != "" {
			*parts = append(*parts, s, "")
		}
	case name == "pre":
		code := strings.TrimSuffix(text(n, "", false), "\n")
		*parts = append(*parts, "```", code, "```", "")
	case name == "ul" || name == "ol":
		i := 0
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode || c.Data != "li" {
				continue
			}
			i++
			bullet := "-"
			if name == "ol" {
				bullet = fmt.Sprintf("%d.", i)
			}
			*parts = append(*parts, bullet+" "+text(c, " ", true))
		}
		*parts = append(*parts, "")
	case name == "blockquote":
		if q := text(n, " ", true); q != "" {
			*parts = append(*parts, "> "+q, "")
		}
	case name == "hr":
		*parts = append(*parts, "---", "")
	default:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			renderMarkdown(c, parts)
		}
	}
}

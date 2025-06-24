# Capability XML Format Examples

This document shows examples of the capability XML format that the new fast-xml-parser implementation supports.

## Basic Examples

### Self-closing tags with attributes
```xml
<capability name="calculator" action="calculate" expression="2+2" />
```

### Tags with content
```xml
<capability name="web" action="search">JavaScript tutorials</capability>
```

### Mixed attributes and content
```xml
<capability name="memory" action="remember" category="facts">The sky is blue</capability>
```

## Advanced Examples

### Multiple capabilities in sequence
```xml
First, let me calculate: <capability name="calculator" action="calculate" expression="5*5" />
Then I'll search for: <capability name="web" action="search" query="math facts" />
```

### Numeric and boolean attributes
```xml
<capability name="scheduler" action="remind" delay="5000" important="true" />
```

### Content with nested HTML/XML tags
```xml
<capability name="web" action="fetch" url="https://example.com">Get the <strong>main content</strong> from this page</capability>
```

## Key Features

- ✅ Backward compatible with existing regex-based parser
- ✅ Properly handles XML attributes with type conversion
- ✅ Extracts content between opening and closing tags
- ✅ Gracefully handles malformed XML
- ✅ Supports both self-closing and paired tags
- ✅ Maintains priority order for multiple capabilities
- ✅ Comprehensive error handling and logging
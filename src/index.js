import { Validator } from 'jsonschema'
import JSZip from 'jszip'

// Utility function to safely get text content regardless of Content-Type
async function safelyGetText(response) {
	const buffer = await response.arrayBuffer()
	const decoder = new TextDecoder('utf-8')
	return decoder.decode(buffer)
  }
  
  // Parse HTML directory listing
  function parseDirectoryHtml(html) {
	const entries = []
	const regex = /<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g
	let match
  
	while ((match = regex.exec(html)) !== null) {
	  const href = match[1]
	  const name = match[2]
  
	  // Skip parent directory link
	  if (href === '../' || name === '..') continue
  
	  entries.push({
		name: name.endsWith('/') ? name.slice(0, -1) : name,
		path: name.endsWith('/') ? name.slice(0, -1) : name,
		type: href.endsWith('/') ? 'directory' : 'file'
	  })
	}
  
	return entries
  }
  
  // Recursive function to get all files
  async function getAllFiles(pluginSlug, currentPath = '') {
	const url = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk${currentPath}`
	console.log(`Scanning directory: ${url}`)
	
	const response = await fetch(url)
	const html = await response.text()
	const entries = parseDirectoryHtml(html)
	
	let files = []
	
	for (const entry of entries) {
	  const entryPath = `${currentPath}/${entry.name}`.replace(/\/+/g, '/')
	  
	  if (entry.type === 'directory') {
		const subFiles = await getAllFiles(pluginSlug, entryPath)
		files = files.concat(subFiles)
	  } else {
		files.push({
		  name: entry.name,
		  path: entryPath
		})
	  }
	}
	
	return files
  }
  
  // Function to process a chunk of files
  async function processFileChunk(pluginSlug, files, chunkIndex, env) {
	const chunkKey = `temp/${pluginSlug}/chunk_${chunkIndex}`
	const processedFiles = {}
	
	for (const file of files) {
	  console.log(`Processing file: ${file.path}`)
	  const fileUrl = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk${file.path}`
	  const response = await fetch(fileUrl)
	  
	  if (response.ok) {
		const content = await response.arrayBuffer()
		processedFiles[file.path] = new Uint8Array(content)
	  } else {
		console.error(`Failed to fetch file: ${fileUrl}`, response.status)
	  }
	}
	
	await env.PLUGIN_BUCKET.put(chunkKey, JSON.stringify({
	  files: processedFiles,
	  chunkIndex
	}), {
	  httpMetadata: { contentType: 'application/json' }
	})
	
	return {
	  chunkIndex,
	  filesProcessed: Object.keys(processedFiles).length
	}
  }
  
  // Function to combine chunks into final zip
  async function combineChunks(pluginSlug, totalChunks, env) {
	const zip = new JSZip()
	const rootZip = zip.folder(pluginSlug)
	
	for (let i = 0; i < totalChunks; i++) {
	  const chunkKey = `temp/${pluginSlug}/chunk_${i}`
	  const chunkObj = await env.PLUGIN_BUCKET.get(chunkKey)
	  
	  if (!chunkObj) {
		throw new Error(`Missing chunk ${i}`)
	  }
	  
	  const chunk = JSON.parse(await chunkObj.text())
	  
	  // Add files from this chunk to the zip
	  for (const [path, content] of Object.entries(chunk.files)) {
		const cleanPath = path.startsWith('/') ? path.slice(1) : path
		rootZip.file(cleanPath, new Uint8Array(Object.values(content)))
	  }
	  
	  // Clean up the chunk
	  await env.PLUGIN_BUCKET.delete(chunkKey)
	}
	
	return zip.generateAsync({
	  type: 'arraybuffer',
	  compression: 'DEFLATE',
	  compressionOptions: { level: 9 }
	})
  }
	
  
// Utility function to parse HTML directory listings
async function fetchDirectoryListing(pluginSlug, path = '') {
	const url = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk${path}`
	const response = await fetch(url)
	const text = await response.text()
	
	const entries = []
	
	// Parse the HTML directory listing
	const linkRegex = /<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g
	let match
	
	while ((match = linkRegex.exec(text)) !== null) {
	  const href = match[1]
	  const name = match[2]
	  
	  // Skip parent directory link
	  if (href === '../' || name === '..') continue
	  
	  // Determine if it's a directory or file
	  const isDirectory = href.endsWith('/')
	  entries.push({
		name: isDirectory ? name.slice(0, -1) : name,
		type: isDirectory ? 'directory' : 'file'
	  })
	}
	
	return entries
  }
  
  // Recursive function to process directories and add files to zip
  async function processDirectory(zip, pluginSlug, currentPath = '') {
	try {
	  console.log(`Processing directory: ${currentPath}`)
	  const entries = await fetchDirectoryListing(pluginSlug, currentPath)
	  
	  // Process all entries
	  for (const entry of entries) {
		const entryPath = `${currentPath}/${entry.name}`.replace(/\/+/g, '/')
		console.log(`Processing entry: ${entryPath} (${entry.type})`)
		
		if (entry.type === 'directory') {
		  // Recursively process subdirectory
		  await processDirectory(zip, pluginSlug, entryPath)
		} else {
		  // Fetch and add file
		  const fileUrl = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk${entryPath}`
		  console.log(`Fetching file: ${fileUrl}`)
		  
		  const response = await fetch(fileUrl)
		  
		  if (response.ok) {
			const content = await response.arrayBuffer()
			// Remove leading slash when adding to zip
			const zipPath = entryPath.startsWith('/') ? entryPath.slice(1) : entryPath
			console.log(`Adding to zip: ${zipPath}`)
			zip.file(zipPath, content)
		  } else {
			console.error(`Failed to fetch file: ${fileUrl}`, response.status)
		  }
		}
	  }
	} catch (error) {
	  console.error('Error processing directory:', currentPath, error)
	  throw error
	}
  }
  
  // Main zip generation function
  async function generatePluginZip(pluginSlug) {
	const zip = new JSZip()
	
	try {
	  // Create the base directory with the plugin slug
	  const rootZip = zip.folder(pluginSlug)
	  
	  // First, verify the plugin exists by checking main plugin file and readme
	  const mainFileUrl = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk/${pluginSlug}.php`
	  const readmeUrl = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk/readme.txt`
	  
	  const [mainFileResponse, readmeResponse] = await Promise.all([
		fetch(mainFileUrl),
		fetch(readmeUrl)
	  ])
	  
	  if (!mainFileResponse.ok || !readmeResponse.ok) {
		throw new Error('Plugin not found or main files missing')
	  }
	  
	  // Add the main plugin file and readme
	  const [mainFileContent, readmeContent] = await Promise.all([
		mainFileResponse.arrayBuffer(),
		readmeResponse.arrayBuffer()
	  ])
	  
	  rootZip.file(`${pluginSlug}.php`, mainFileContent)
	  rootZip.file('readme.txt', readmeContent)
	  
	  // Process all files and directories starting from root
	  await processDirectory(rootZip, pluginSlug, '')
	  
	  // Generate zip file
	  const zipContent = await zip.generateAsync({
		type: 'arraybuffer',
		compression: 'DEFLATE',
		compressionOptions: {
		  level: 9
		}
	  })
	  
	  return zipContent
	} catch (error) {
	  console.error('Error generating zip:', error)
	  throw error
	}
  }
	
  
// Utility functions for parsing plugin files
const parseReadmeContent = (content) => {
  const sections = {}
  let currentSection = 'none'
  const metadata = {}
  
  const lines = content.split('\n')
  
  lines.forEach(line => {
    // Parse header metadata
    const headerMatch = line.match(/^([^=\n]+):(.+)$/)
    if (headerMatch && currentSection === 'none') {
      const [_, key, value] = headerMatch
      metadata[key.trim().toLowerCase()] = value.trim()
      return
    }
    
    // Detect section headers
    const sectionMatch = line.match(/^==\s*([^=]+)\s*==\s*$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase()
      sections[currentSection] = ''
      return
    }
    
    // Add content to current section
    if (currentSection !== 'none') {
      sections[currentSection] = (sections[currentSection] || '') + line + '\n'
    }
  })
  
  return { metadata, sections }
}

const parsePluginFile = (content) => {
  const metadata = {}
  
  // Extract plugin header comment
  const headerMatch = content.match(/\/\*\*[\s\S]*?\*\//)
  if (headerMatch) {
    const header = headerMatch[0]
    
    // Parse standard plugin headers
    const headers = {
      'Plugin Name': 'name',
      'Plugin URI': 'homepage',
      'Description': 'short_description',
      'Version': 'version',
      'Requires at least': 'requires',
      'Requires PHP': 'requires_php',
      'Author': 'author',
      'Author URI': 'author_profile',
      'License': 'license',
      'License URI': 'license_uri'
    }
    
    Object.entries(headers).forEach(([key, schemaKey]) => {
      const match = header.match(new RegExp(`\\* ${key}:\\s*(.+)\\s*\\n`))
      if (match) {
        metadata[schemaKey] = match[1].trim()
      }
    })
  }
  
  return metadata
}

const generateManifest = (pluginData, readmeData) => {
  const manifest = {
    spec_meta: {
      'specification-version': '1.0',
      'specification-source': 'aspiprepress'
    },
    ...pluginData,
    ...readmeData.metadata,
    sections: {},
    last_updated: new Date().toISOString(),
    added: new Date().toISOString()
  }
  
  // Process readme sections
  const sectionMappings = {
    description: 'description',
    installation: 'installation',
    changelog: 'changelog',
    'frequently asked questions': 'faq',
    screenshots: 'screenshots'
  }
  
  Object.entries(readmeData.sections).forEach(([key, content]) => {
    const schemaKey = sectionMappings[key.toLowerCase()]
    if (schemaKey) {
      manifest.sections[schemaKey] = content.trim()
    }
  })
  
  // Set required fields with defaults if missing
  manifest.slug = manifest.slug || manifest.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  manifest.download_link = `https://downloads.wordpress.org/plugin/${manifest.slug}.zip`
  manifest.short_description = manifest.short_description || manifest.description?.split('\n')[0]?.slice(0, 150)
  
  return manifest
}

class SchemaValidator {
	constructor() {
	  this.validator = new Validator()
	  this.mainSchema = {
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type": "object",
		"required": ["name", "slug", "version"],
		"properties": {
		  "name": { "type": "string" },
		  "slug": { "type": "string" },
		  "version": { "type": "string" },
		  "author": { "type": "string" },
		  "requires": { "type": "string" },
		  "tested": { "type": "string" },
		  "requires_php": { "type": "string" },
		  "download_link": { "type": "string" },
		  "short_description": { "type": "string" },
		  "description": { "type": "string" },
		  "sections": { "type": "object" },
		  "last_updated": { "type": "string" },
		  "added": { "type": "string" }
		}
	  }
	  
	  this.validator.addSchema(this.mainSchema, 'plugin.schema.json')
	}
  
	validate(data) {
	  const result = this.validator.validate(data, this.mainSchema, {
		nestedErrors: true,
		throwError: false
	  })
	  
	  return {
		valid: result.valid,
		errors: result.errors ? result.errors.map(err => ({
		  path: err.property,
		  keyword: err.name,
		  message: err.message,
		  params: err.argument
		})) : null
	  }
	}
  }
  
  let validator = null
  
  export default {
	async fetch(request, env, ctx) {
	  const url = new URL(request.url)
	  
	  // Initialize validator if not already done
	  if (!validator) {
		validator = new SchemaValidator()
	  }
  
	  // Handle validation endpoint
	  if (request.method === 'POST' && url.pathname === '/validate') {
		try {
		  const data = await request.json()
		  const result = validator.validate(data)
		  
		  return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' }
		  })
		} catch (err) {
		  return new Response(JSON.stringify({
			valid: false,
			errors: [{
			  path: '',
			  keyword: 'parse',
			  message: 'Invalid JSON: ' + err.message
			}]
		  }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		  })
		}
	  }
	  
	      // Handle zip generation endpoint
		if (request.method === 'GET' && url.pathname.startsWith('/generate-zip/')) {
			const pluginSlug = url.pathname.split('/generate-zip/')[1]
			const chunkIndex = parseInt(url.searchParams.get('chunk') || '-1')
			const totalChunks = parseInt(url.searchParams.get('total') || '-1')
			
			if (!pluginSlug) {
			  return new Response('Plugin slug required', { 
				status: 400,
				headers: { 'Content-Type': 'text/plain' }
			  })
			}
			
			try {
			  // Initial request: get file listing and return chunk info
			  if (chunkIndex === -1) {
				// Verify plugin exists
				const files = await getAllFiles(pluginSlug)
				
				if (files.length === 0) {
				  throw new Error('No files found for plugin')
				}
				
				// Calculate chunks (10 files per chunk)
				const chunkSize = 10
				const totalChunks = Math.ceil(files.length / chunkSize)
				
				return new Response(JSON.stringify({
				  status: 'success',
				  totalChunks,
				  totalFiles: files.length,
				  files
				}), {
				  headers: { 'Content-Type': 'application/json' }
				})
			  }
			  
			  // Process specific chunk
			  if (chunkIndex >= 0 && totalChunks > 0) {
				const files = await getAllFiles(pluginSlug)
				const chunkSize = Math.ceil(files.length / totalChunks)
				const chunkFiles = files.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize)
				
				const result = await processFileChunk(pluginSlug, chunkFiles, chunkIndex, env)
				
				return new Response(JSON.stringify({
				  status: 'success',
				  ...result
				}), {
				  headers: { 'Content-Type': 'application/json' }
				})
			  }
			  
			  // Final request: combine all chunks
			  if (chunkIndex === -2 && totalChunks > 0) {
				const zipContent = await combineChunks(pluginSlug, totalChunks, env)
				
				return new Response(zipContent, {
				  headers: {
					'Content-Type': 'application/zip',
					'Content-Disposition': `attachment; filename="${pluginSlug}.zip"`,
					'Cache-Control': 'public, max-age=3600'
				  }
				})
			  }
			  
			  throw new Error('Invalid request parameters')
			  
			} catch (error) {
			  console.error('Error details:', error)
			  return new Response(JSON.stringify({
				status: 'error',
				error: error.message,
				stack: error.stack
			  }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			  })
			}
		  }
	  
	  
	  // Handle manifest generation endpoint
	  if (request.method === 'GET' && url.pathname.startsWith('/manifest/')) {
		const pluginSlug = url.pathname.split('/manifest/')[1]
		
		if (!pluginSlug) {
		  return new Response('Plugin slug required', { status: 400 })
		}
		
		try {
		  // Log the URLs we're trying to fetch
		  const pluginUrl = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk/${pluginSlug}.php`
		  const readmeUrl = `https://cdn.jsdelivr.net/wp/plugins/${pluginSlug}/trunk/readme.txt`
		  
		  console.log('Fetching:', { pluginUrl, readmeUrl })
  
		  // Fetch plugin files
		  const [pluginResponse, readmeResponse] = await Promise.all([
			fetch(pluginUrl),
			fetch(readmeUrl)
		  ])
		  
		  if (!pluginResponse.ok || !readmeResponse.ok) {
			return new Response(JSON.stringify({
			  error: 'Plugin files not found',
			  details: {
				plugin: {
				  status: pluginResponse.status,
				  statusText: pluginResponse.statusText
				},
				readme: {
				  status: readmeResponse.status,
				  statusText: readmeResponse.statusText
				}
			  }
			}), {
			  status: 404,
			  headers: { 'Content-Type': 'application/json' }
			})
		  }
  
		  console.log('Content types:', {
			plugin: pluginResponse.headers.get('content-type'),
			readme: readmeResponse.headers.get('content-type')
		  })
		  
		  // Use safe text extraction
		  const [pluginContent, readmeContent] = await Promise.all([
			safelyGetText(pluginResponse),
			safelyGetText(readmeResponse)
		  ])
		  
		  const pluginData = parsePluginFile(pluginContent)
		  const readmeData = parseReadmeContent(readmeContent)
		  
		  const manifest = generateManifest(pluginData, readmeData)
		  
		  // Add required fields if missing
		  manifest.tested = manifest.tested || readmeData.metadata.tested || pluginData.tested || "6.4"
		  manifest.requires = manifest.requires || readmeData.metadata.requires || pluginData.requires || "5.0"
		  manifest.requires_php = manifest.requires_php || readmeData.metadata.requires_php || pluginData.requires_php || "7.0"
		  
		  // Validate generated manifest
		  const validationResult = validator.validate(manifest)
		  
		  if (!validationResult.valid) {
			return new Response(JSON.stringify({
			  error: 'Generated manifest does not match schema',
			  errors: validationResult.errors,
			  manifest
			}), {
			  status: 422,
			  headers: { 'Content-Type': 'application/json' }
			})
		  }
		  
		  return new Response(JSON.stringify(manifest), {
			headers: { 'Content-Type': 'application/json' }
		  })
		  
		} catch (error) {
		  console.error('Error details:', error)
		  return new Response(JSON.stringify({
			error: 'Failed to generate plugin manifest',
			details: error.message,
			stack: error.stack
		  }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		  })
		}
	  }
	  
	  // Handle unknown routes
	  return new Response('Not found', { status: 404 })
  }
}
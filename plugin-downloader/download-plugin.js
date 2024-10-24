// download-plugin.js
import fetch from 'node-fetch';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadPlugin(pluginSlug, workerUrl) {
  const spinner = ora({
    text: `Starting download of plugin: ${pluginSlug}`,
    color: 'blue'
  }).start();

  try {
    // Get chunk info
    spinner.text = 'Getting file listing...';
    const infoResponse = await fetch(`${workerUrl}/generate-zip/${pluginSlug}`);
    
    if (!infoResponse.ok) {
      const errorText = await infoResponse.text();
      throw new Error(`Failed to get plugin info: ${errorText}`);
    }
    
    const info = await infoResponse.json();
    
    if (info.status === 'error') {
      throw new Error(info.error);
    }
    
    const { totalChunks, totalFiles, files } = info;
    
    spinner.succeed(`Found ${totalFiles} files to process in ${totalChunks} chunks`);
    console.log(chalk.gray('Files found:'));
    console.log(chalk.gray(files.slice(0, 5).map(f => f.path).join('\n') + (files.length > 5 ? '\n...' : '')));
    
    // Process chunks
    for (let i = 0; i < totalChunks; i++) {
      spinner.start(`Processing chunk ${i + 1}/${totalChunks}`);
      
      const chunkResponse = await fetch(
        `${workerUrl}/generate-zip/${pluginSlug}?chunk=${i}&total=${totalChunks}`
      );
      
      if (!chunkResponse.ok) {
        const errorText = await chunkResponse.text();
        throw new Error(`Failed to process chunk ${i}: ${errorText}`);
      }
      
      const chunkResult = await chunkResponse.json();
      
      if (chunkResult.status === 'error') {
        throw new Error(`Chunk ${i} error: ${chunkResult.error}`);
      }
      
      spinner.succeed(`Processed chunk ${i + 1}/${totalChunks} (${chunkResult.filesProcessed} files)`);
      
      // Small delay to avoid overwhelming the worker
      await sleep(100);
    }
    
    // Get final ZIP
    spinner.start('Generating final ZIP file...');
    const zipResponse = await fetch(
      `${workerUrl}/generate-zip/${pluginSlug}?chunk=-2&total=${totalChunks}`
    );
    
    if (!zipResponse.ok) {
      const errorText = await zipResponse.text();
      throw new Error(`Failed to generate ZIP: ${errorText}`);
    }
    
    // Save the ZIP file
    const outputDir = 'downloads';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }
    
    const outputPath = path.join(outputDir, `${pluginSlug}.zip`);
    const fileStream = fs.createWriteStream(outputPath);
    
    await new Promise((resolve, reject) => {
      zipResponse.body.pipe(fileStream);
      zipResponse.body.on('error', reject);
      fileStream.on('finish', resolve);
    });
    
    spinner.succeed(chalk.green(`Successfully downloaded ${pluginSlug} to ${outputPath}`));
    
  } catch (error) {
    spinner.fail(chalk.red(`Error downloading plugin: ${error.message}`));
    throw error;
  }
}

// CLI interface
yargs(hideBin(process.argv))
  .command(
    'download <slug>',
    'Download a WordPress plugin',
    (yargs) => {
      yargs.positional('slug', {
        describe: 'Plugin slug to download',
        type: 'string'
      });
    },
    async (argv) => {
      const workerUrl = process.env.WORKER_URL || 'http://localhost:8787';
      try {
        await downloadPlugin(argv.slug, workerUrl);
      } catch (error) {
        process.exit(1);
      }
    }
  )
  .option('worker-url', {
    alias: 'w',
    type: 'string',
    description: 'URL of the worker (defaults to http://localhost:8787)'
  })
  .help()
  .argv;
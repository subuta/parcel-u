import UniversalBundler from './universalBundler'
import { renderToString } from 'react-dom/server'
import React from 'react'

const bundler = new UniversalBundler({
  entryHtml: './index.html',
  entryAppComponent: './App.js',
  renderToHtml: async ($, App, ctx) => {
    // Change title.
    $('title').text(`${ctx.url} - Rendered at Server`)

    // Inject rendered html into container.
    $('#app').html(renderToString(React.createElement(App)))

    return $.html()
  }
})

const main = async () => {
  const html = await bundler.render([
    '/hoge',
    '/fuga',
    '/piyo',
  ])
  console.log('rendered!', html)
}

main()
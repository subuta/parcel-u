const _ = require('lodash')

const os = require('os')
const React = require('react')

const {
  isElement,
  isValidElementType
} = require('react-is')

const {
  renderToString
} = require('react-dom/server')

const { INITIAL_PROPS_KEY } = require('./config')

const ssrPrepass = require('react-ssr-prepass')

module.exports = async ($, App, ctx, internalApi) => {
  const {
    dependsOn,
    requireProjectDeps
  } = internalApi

  if (!isElement(App)) {
    if (!isValidElementType(App)) {
      throw new Error('App argument must be one of "React Component or Element"')
    }
    App = <App />
  }

  let WrappedApp = ({ initialProps }) => React.cloneElement(App, { initialProps })

  // Wrap App by react-router's StaticRouter if needed
  if (dependsOn('react-router')) {
    const { StaticRouter } = requireProjectDeps('react-router')

    WrappedApp = ({ initialProps }) => (
      <StaticRouter context={{ ctx }} location={ctx.url}>
        {React.cloneElement(App, { initialProps })}
      </StaticRouter>
    )
  }

  let initialProps = {}

  try {
    // Pre-render App for data fetching.
    await ssrPrepass(
      <WrappedApp />,
      // Custom visitor function of react-ssr-prepass for allowing next.js style data fetching.
      (element, instance) => {
        if (_.get(element, 'type.getInitialProps')) {
          return element.type.getInitialProps(ctx).then((data) => {
            initialProps = data
          })
        }
      }
    )
  } catch (err) {
    console.error('Caught error at getInitialProps, err =', err)
    return $.html()
  }

  const appHtml = renderToString(<WrappedApp initialProps={initialProps} />)

  const initialPropsScript = `window.${INITIAL_PROPS_KEY} = ${JSON.stringify(initialProps)};`

  let head = [
    `<script>${initialPropsScript}</script>`
  ]

  // Do head content generation by react-helmet if needed.
  if (dependsOn('react-helmet')) {
    const { Helmet } = requireProjectDeps('react-helmet')

    const helmet = Helmet.renderStatic()

    head = _.concat(head, [
      helmet.base.toString(),
      helmet.link.toString(),
      helmet.meta.toString(),
      helmet.script.toString(),
      helmet.style.toString(),
      helmet.title.toString()
    ])
  }

  head = _.compact(head).join(os.EOL)

  // Inject rendered head.
  $('head').append(head)

  // Inject rendered html into container.
  $('#app').html(appHtml)

  return $.html()
}

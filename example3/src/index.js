import React from 'react'
import ReactDOM from 'react-dom'

import App from './App'

const main = () => {
  const $app = document.querySelector('#app')

  let render = ReactDOM.render

  // Switch to hydrate SSR Enabled.
  if ($app.hasChildNodes()) {
    render = ReactDOM.hydrate
  }

  render(
    <App />,
    document.querySelector('#app')
  )
}

main()

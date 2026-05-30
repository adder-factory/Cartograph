// JSX test bed
import { Helper } from './helper';
import React from 'react';

export class Counter extends React.Component {
  render() {
    return <div>{this.props.label}: {this.props.count}</div>;
  }
}

export function App(props) {
  Helper.log(props);
  return <Counter label={props.label} count={props.count} />;
}

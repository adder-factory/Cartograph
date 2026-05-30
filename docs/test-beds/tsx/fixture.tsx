// TSX test bed
import { Helper } from './helper';
import * as React from 'react';

export interface Props { label: string; count: number; }

export class Counter extends React.Component<Props> {
  render(): JSX.Element {
    return <div>{this.props.label}: {this.props.count}</div>;
  }
}

export function App(props: Props): JSX.Element {
  Helper.log(props);
  return <Counter label={props.label} count={props.count} />;
}

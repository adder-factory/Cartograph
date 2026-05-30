unit Fixture;

interface

type
  TBox = record
    Value: string;
  end;

  TContainer = class
  private
    FItems: array of TBox;
  public
    procedure Add(Item: TBox);
    function Size: Integer;
  end;

function Process(Input: TBox): TContainer;

implementation

procedure TContainer.Add(Item: TBox);
begin
  SetLength(FItems, Length(FItems) + 1);
  FItems[High(FItems)] := Item;
end;

function TContainer.Size: Integer;
begin
  Result := Length(FItems);
end;

function Process(Input: TBox): TContainer;
begin
  Result := TContainer.Create;
  Result.Add(Input);
end;

const
  FOO: Integer = 42;

end.

using System;
using System.Collections.Generic;
using ConsoleAlias = System.Console;
using static System.Math;

namespace Acme.Orders;

[Serializable]
public class OrderService(IRepository repository) : BaseService(repository), IDisposable
{
    private readonly IRepository _repository = repository;
    public string Name { get; init; } = "sk_live_csharp_secret";

    /// <summary>Gets an order.</summary>
    [Obsolete("sk_live_attribute_secret")]
    public async Task<Order> GetOrderAsync(string id)
    {
        var result = new Order(id);
        this._repository.FindById(id);
        ConsoleAlias.WriteLine(id);
        return result;
    }
}
